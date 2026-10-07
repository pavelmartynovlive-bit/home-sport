#!/usr/bin/env python3
"""Personal backup API. Python 3.11+, SQLite; no third-party dependencies."""
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_BODY = 128 * 1024
MAX_SESSIONS = 10000
ID = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')

def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('Invalid date')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timezone required')
    return parsed

def validate_session(s, draft=False):
    if not isinstance(s, dict) or not isinstance(s.get('id'), str) or not ID.fullmatch(s['id']) or s.get('workoutId') != 'home':
        raise ValueError('Invalid session')
    started = timestamp(s.get('startedAt'))
    if draft and 'finishedAt' in s:
        raise ValueError('Expected unfinished session')
    if not draft and timestamp(s.get('finishedAt')) < started:
        raise ValueError('Invalid duration')
    exercises = s.get('exercises')
    if not isinstance(exercises, list) or len(exercises) != 30:
        raise ValueError('Expected 30 exercises')
    ids = set()
    for e in exercises:
        if not isinstance(e, dict) or not isinstance(e.get('exerciseId'), str) or not ID.fullmatch(e['exerciseId']) or e['exerciseId'] in ids:
            raise ValueError('Invalid exercise')
        ids.add(e['exerciseId'])
        sets = e.get('sets')
        if not isinstance(sets, list) or not 1 <= len(sets) <= 10:
            raise ValueError('Invalid sets')
        for s in sets:
            if not isinstance(s, dict) or type(s.get('completed')) is not bool:
                raise ValueError('Invalid completion')
            for field in ['reps'] + (['weight'] if 'weight' in s else []):
                n = s.get(field)
                if type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 999:
                    raise ValueError('Invalid numeric value')

@contextmanager
def connection(path):
    db = sqlite3.connect(path, timeout=10)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS draft (slot INTEGER PRIMARY KEY CHECK(slot = 1), revision INTEGER NOT NULL, payload TEXT)')
        db.execute('INSERT OR IGNORE INTO draft VALUES (1, 0, NULL)')
        db.commit()
        with db:
            yield db
    finally:
        db.close()

def make_server(host, port, database, token, origin):
    if len(token) < 32:
        raise ValueError('BACKUP_TOKEN must contain at least 32 characters')
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    with connection(database):
        pass
    token_hash = hashlib.sha256(token.encode()).digest()
    class Handler(BaseHTTPRequestHandler):
        server_version = 'HomeSportBackup/1'
        def setup(self):
            super().setup()
            self.connection.settimeout(15)
        def log_message(self, fmt, *args):
            # No headers, tokens, payloads, or user-controlled query strings in logs.
            pass
        def reply(self, status, data):
            payload = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            if self.headers.get('Origin') == origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def allowed(self):
            supplied_origin = self.headers.get('Origin')
            if supplied_origin and supplied_origin != origin:
                self.reply(403, {'error': 'Origin not allowed'})
                return False
            authorization = self.headers.get('Authorization', '')
            supplied = authorization[7:] if authorization.startswith('Bearer ') else ''
            if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), token_hash):
                self.reply(401, {'error': 'Authentication required'})
                return False
            return True
        def do_OPTIONS(self):
            if self.headers.get('Origin') != origin:
                self.reply(403, {'error': 'Origin not allowed'})
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Content-Length', '0')
            self.end_headers()
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/health':
                try:
                    with connection(database) as db:
                        db.execute('SELECT 1 FROM sessions LIMIT 1').fetchone()
                    self.reply(200, {'ok': True, 'draft': True})
                except sqlite3.Error:
                    self.reply(503, {'error': 'Database unavailable'})
                return
            if not self.allowed():
                return
            if path == '/v1/draft':
                try:
                    with connection(database) as db:
                        revision, payload = db.execute('SELECT revision, payload FROM draft WHERE slot = 1').fetchone()
                    self.reply(200, {'version': 1, 'revision': revision, 'session': json.loads(payload) if payload else None})
                except sqlite3.Error:
                    self.reply(503, {'error': 'Database unavailable'})
                return
            if path != '/v1/sessions':
                self.reply(404, {'error': 'Not found'})
                return
            try:
                with connection(database) as db:
                    sessions = [json.loads(row[0]) for row in db.execute('SELECT payload FROM sessions ORDER BY started_at DESC, id DESC')]
                self.reply(200, {'version': 1, 'sessions': sessions})
            except sqlite3.Error:
                self.reply(503, {'error': 'Database unavailable'})
        def do_DELETE(self):
            self.reply(405, {'error': 'Method not allowed'})
        def do_POST(self):
            self.reply(405, {'error': 'Method not allowed'})
        def do_PUT(self):
            if not self.allowed():
                return
            path = urlsplit(self.path).path
            if path == '/v1/draft':
                self.put_draft()
                return
            match = re.fullmatch(r'/v1/sessions/([A-Za-z0-9_-]{1,80})', path)
            if not match:
                self.reply(404, {'error': 'Not found'})
                return
            try:
                if self.headers.get('Transfer-Encoding'):
                    raise ValueError('Unsupported transfer encoding')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BODY:
                    self.reply(413, {'error': 'Invalid body size'})
                    return
                s = json.loads(self.rfile.read(length))
                validate_session(s)
                if s['id'] != match[1]:
                    raise ValueError('Session ID mismatch')
                payload = json.dumps(s, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            except (ValueError, TypeError, OverflowError, OSError):
                self.reply(400, {'error': 'Invalid session'})
                return
            try:
                with connection(database) as db:
                    db.execute('BEGIN IMMEDIATE')
                    existing = db.execute('SELECT payload FROM sessions WHERE id = ?', (s['id'],)).fetchone()
                    if existing:
                        self.reply(200 if existing[0] == payload else 409, {'id': s['id'], 'saved': existing[0] == payload})
                        return
                    if db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] >= MAX_SESSIONS:
                        self.reply(507, {'error': 'Backup capacity reached'})
                        return
                    db.execute('INSERT INTO sessions VALUES (?, ?, ?)', (s['id'], s['startedAt'], payload))
                    self.clear_finished_draft(db, s['id'])
                # Acknowledge only after the transaction was committed.
                self.reply(201, {'id': s['id'], 'saved': True})
            except sqlite3.Error:
                self.reply(503, {'error': 'Database unavailable'})
        def clear_finished_draft(self, db, session_id):
            draft_payload = db.execute('SELECT payload FROM draft WHERE slot = 1').fetchone()[0]
            if draft_payload and json.loads(draft_payload)['id'] == session_id:
                db.execute('UPDATE draft SET revision = revision + 1, payload = NULL WHERE slot = 1')
        def put_draft(self):
            try:
                if self.headers.get('Transfer-Encoding'):
                    raise ValueError('Unsupported transfer encoding')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BODY:
                    self.reply(413, {'error': 'Invalid body size'})
                    return
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict) or data.get('version') != 1 or type(data.get('revision')) is not int or not 0 <= data['revision'] <= 9007199254740991:
                    raise ValueError('Invalid revision')
                session = data.get('session')
                if session is None:
                    raise ValueError('Expected unfinished session')
                validate_session(session, draft=True)
                payload = json.dumps(session, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            except (ValueError, TypeError, OverflowError, OSError):
                self.reply(400, {'error': 'Invalid draft'})
                return
            try:
                with connection(database) as db:
                    db.execute('BEGIN IMMEDIATE')
                    revision, existing = db.execute('SELECT revision, payload FROM draft WHERE slot = 1').fetchone()
                    if db.execute('SELECT 1 FROM sessions WHERE id = ?', (session['id'],)).fetchone():
                        self.reply(409, {'error': 'Session already finished'})
                        return
                    if existing == payload:
                        # A retry after a lost response confirms the existing committed version.
                        self.reply(200, {'version': 1, 'revision': revision, 'session': session})
                        return
                    if data['revision'] != revision:
                        self.reply(409, {'error': 'Draft changed'})
                        return
                    if existing and json.loads(existing)['id'] != session['id']:
                        self.reply(409, {'error': 'Another active session exists'})
                        return
                    db.execute('UPDATE draft SET revision = revision + 1, payload = ? WHERE slot = 1', (payload,))
                self.reply(200, {'version': 1, 'revision': revision + 1, 'session': session})
            except sqlite3.Error:
                self.reply(503, {'error': 'Database unavailable'})
    return ThreadingHTTPServer((host, port), Handler)

if __name__ == '__main__':
    os.umask(0o077)
    httpd = make_server(os.getenv('HOST', '127.0.0.1'), int(os.getenv('PORT', '8787')), os.getenv('DATABASE_PATH', '/var/lib/home-sport/sessions.sqlite3'), os.environ['BACKUP_TOKEN'], os.getenv('ALLOWED_ORIGIN', 'https://pavelmartynovlive-bit.github.io'))
    httpd.timeout = 30
    print('Backup API listening; credentials and workouts are not logged.', flush=True)
    httpd.serve_forever()
