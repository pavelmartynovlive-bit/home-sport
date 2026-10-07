import copy
import json
import secrets
import sqlite3
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from server.server import make_server

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / 'history.sqlite3')
        self.token = secrets.token_hex(32)
        self.http = make_server('127.0.0.1', 0, self.db, self.token, 'https://pavelmartynovlive-bit.github.io')
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.session = {'id': 'session-test', 'workoutId': 'home', 'startedAt': '2026-10-06T10:00:00Z', 'finishedAt': '2026-10-06T10:42:00Z', 'exercises': [{'exerciseId': f'exercise-{i}', 'sets': [{'reps': 15, 'completed': True}]} for i in range(30)]}
    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.temp.cleanup()
    def request(self, path, method='GET', data=None, key=None, origin=None):
        headers = {'Authorization': f'Bearer {self.token if key is None else key}'}
        if origin:
            headers['Origin'] = origin
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.url + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as e:
            response = e
        body = response.read()
        return response.status, json.loads(body) if body else None, response.headers
    def test_new_29_exercise_sessions_and_drafts_with_legacy_history(self):
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', self.session)[0], 201)
        current = copy.deepcopy(self.session)
        current['id'] = 'current-29'
        current['exercises'].pop(22)
        draft = copy.deepcopy(current); del draft['finishedAt']
        self.assertEqual(self.request('/v1/draft', 'PUT', {'version': 1, 'revision': 0, 'session': draft})[0], 200)
        self.assertEqual(self.request('/v1/draft')[1]['session'], draft)
        invalid = copy.deepcopy(current); invalid['exercises'].pop()
        self.assertEqual(self.request('/v1/sessions/current-29', 'PUT', invalid)[0], 400)
        self.assertEqual(self.request('/v1/sessions/current-29', 'PUT', current)[0], 201)
        self.assertEqual(self.request('/v1/draft')[1]['session'], None)
        self.assertCountEqual(self.request('/v1/sessions')[1]['sessions'], [self.session, current])
        self.assertEqual(self.request('/health')[1]['exerciseCounts'], [29, 30])
    def test_authentication_and_origin(self):
        self.assertEqual(self.request('/v1/sessions', key='wrong')[0], 401)
        self.assertEqual(self.request('/v1/sessions', origin='https://evil.example')[0], 403)
        status, _, headers = self.request('/v1/sessions', origin='https://pavelmartynovlive-bit.github.io')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://pavelmartynovlive-bit.github.io')
        self.assertEqual(headers['Cache-Control'], 'no-store')
    def test_duplicates_and_conflicts_never_overwrite(self):
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', self.session)[0], 201)
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', self.session)[0], 200)
        changed = copy.deepcopy(self.session)
        changed['exercises'][0]['sets'][0]['reps'] = 10
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', changed)[0], 409)
        self.assertEqual(self.request('/v1/sessions')[1]['sessions'], [self.session])
    def test_rejects_unfinished_malformed_and_mismatched_sessions(self):
        invalid = copy.deepcopy(self.session); del invalid['finishedAt']
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', invalid)[0], 400)
        invalid = copy.deepcopy(self.session); invalid['exercises'][0]['sets'][0]['reps'] = -1
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', invalid)[0], 400)
        self.assertEqual(self.request('/v1/sessions/other-id', 'PUT', self.session)[0], 400)
        self.assertEqual(self.request('/v1/sessions')[1]['sessions'], [])
    def test_preflight_and_no_delete(self):
        self.assertEqual(self.request('/v1/sessions/session-test', 'OPTIONS', origin='https://pavelmartynovlive-bit.github.io')[0], 204)
        self.assertEqual(self.request('/v1/sessions/session-test', 'OPTIONS', origin='https://evil.example')[0], 403)
        self.assertEqual(self.request('/v1/sessions/session-test', 'DELETE')[0], 405)
    def test_draft_updates_retries_and_stale_writes(self):
        draft = copy.deepcopy(self.session); del draft['finishedAt']
        self.assertEqual(self.request('/v1/draft')[1], {'version': 1, 'revision': 0, 'session': None})
        self.assertEqual(self.request('/v1/draft', key='wrong')[0], 401)
        data = {'version': 1, 'revision': 0, 'session': draft}
        self.assertEqual(self.request('/v1/draft', 'PUT', data)[1]['revision'], 1)
        self.assertEqual(self.request('/v1/draft', 'PUT', data)[1]['revision'], 1)
        changed = copy.deepcopy(draft); changed['exercises'][0]['sets'][0]['reps'] = 20
        self.assertEqual(self.request('/v1/draft', 'PUT', {**data, 'session': changed})[0], 409)
        self.assertEqual(self.request('/v1/draft', 'PUT', {**data, 'revision': 1, 'session': changed})[1]['revision'], 2)
        self.assertEqual(self.request('/v1/draft', 'PUT', data)[0], 409)
        other = {**changed, 'id': 'other-active'}
        self.assertEqual(self.request('/v1/draft', 'PUT', {**data, 'revision': 2, 'session': other})[0], 409)
        self.assertEqual(self.request('/v1/draft')[1]['session'], changed)
    def test_finish_clears_draft_atomically_and_late_requests_cannot_resurrect_it(self):
        draft = copy.deepcopy(self.session); del draft['finishedAt']
        data = {'version': 1, 'revision': 0, 'session': draft}
        self.request('/v1/draft', 'PUT', data)
        self.assertEqual(self.request('/v1/sessions/session-test', 'PUT', self.session)[0], 201)
        remote = self.request('/v1/draft')[1]
        self.assertEqual(remote, {'version': 1, 'revision': 2, 'session': None})
        self.assertEqual(self.request('/v1/draft', 'PUT', data)[0], 409)
        self.assertEqual(self.request('/v1/draft', 'PUT', {**data, 'revision': 2})[0], 409)
        self.assertEqual(self.request('/v1/draft')[1], remote)
        self.assertEqual(self.request('/v1/sessions')[1]['sessions'], [self.session])
    def test_draft_validation_and_snapshot_survival(self):
        draft = copy.deepcopy(self.session); del draft['finishedAt']
        for data in [{'version': 1, 'revision': True, 'session': draft}, {'version': 1, 'revision': 0, 'session': self.session}, {'version': 1, 'revision': 0, 'session': None}]:
            self.assertEqual(self.request('/v1/draft', 'PUT', data)[0], 400)
        self.request('/v1/draft', 'PUT', {'version': 1, 'revision': 0, 'session': draft})
        snapshot = str(Path(self.temp.name) / 'draft-snapshot.sqlite3')
        subprocess.run(['python3', 'server/backup.py', self.db, snapshot], check=True, capture_output=True)
        with sqlite3.connect(snapshot) as db:
            revision, payload = db.execute('SELECT revision, payload FROM draft WHERE slot = 1').fetchone()
            self.assertEqual(revision, 1); self.assertEqual(json.loads(payload), draft)
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.http = make_server('127.0.0.1', 0, snapshot, self.token, 'https://pavelmartynovlive-bit.github.io')
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.assertEqual(self.request('/v1/draft')[1]['session'], draft)
    def test_additive_migration_keeps_legacy_history(self):
        legacy = str(Path(self.temp.name) / 'legacy.sqlite3')
        with sqlite3.connect(legacy) as db:
            db.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL)')
            db.execute('INSERT INTO sessions VALUES (?, ?, ?)', (self.session['id'], self.session['startedAt'], json.dumps(self.session)))
        upgraded = make_server('127.0.0.1', 0, legacy, self.token, 'https://pavelmartynovlive-bit.github.io')
        upgraded.server_close()
        with sqlite3.connect(legacy) as db:
            self.assertEqual(json.loads(db.execute('SELECT payload FROM sessions').fetchone()[0]), self.session)
            self.assertEqual(db.execute('SELECT revision, payload FROM draft').fetchone(), (0, None))
    def test_committed_database_survives_restart_and_backup_restores(self):
        self.request('/v1/sessions/session-test', 'PUT', self.session)
        snapshot = str(Path(self.temp.name) / 'snapshot.sqlite3')
        subprocess.run(['python3', 'server/backup.py', self.db, snapshot], check=True, capture_output=True)
        with sqlite3.connect(snapshot) as db:
            self.assertEqual(json.loads(db.execute('SELECT payload FROM sessions').fetchone()[0]), self.session)
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        self.http = make_server('127.0.0.1', 0, self.db, self.token, 'https://pavelmartynovlive-bit.github.io')
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.assertEqual(self.request('/v1/sessions')[1]['sessions'], [self.session])
if __name__ == '__main__':
    unittest.main()
