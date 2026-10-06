#!/usr/bin/env python3
"""Consistent SQLite snapshot, including committed WAL transactions."""
import argparse
import os
import sqlite3
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('database')
parser.add_argument('destination')
args = parser.parse_args()
os.umask(0o077)
source = Path(args.database).resolve()
if not source.is_file():
    raise SystemExit('Source database does not exist')
target = Path(args.destination).resolve()
if source == target or target.exists():
    raise SystemExit('Destination must be a new file')
target.parent.mkdir(parents=True, exist_ok=True)
try:
    with sqlite3.connect(f'{source.as_uri()}?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup integrity check failed')
except Exception:
    target.unlink(missing_ok=True)
    raise
print('SQLite backup created and verified. Copy it to storage outside this VPS.')
