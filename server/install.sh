#!/usr/bin/env bash
# Run on the VPS after reviewing this file: sudo bash server/install.sh
# Installs only the backup API; leaves existing web server/TLS configuration intact.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo 'Run with sudo on your Ubuntu/Debian VPS.' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { echo 'Install Python 3.11+ first.' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"'
id home-sport >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin home-sport
install -d -m 0755 /opt/home-sport/server
install -m 0644 "$script_dir/server.py" "$script_dir/backup.py" /opt/home-sport/server/
install -d -o home-sport -g home-sport -m 0700 /var/lib/home-sport
# Exclusive creation protects an existing key and database configuration on repeat installs.
python3 - <<'PY'
import os,secrets
path='/etc/home-sport.env'
try:
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except FileExistsError:
 pass
else:
 with os.fdopen(fd,'w') as out:
  out.write('BACKUP_TOKEN='+secrets.token_hex(32)+'\n')
  out.write('ALLOWED_ORIGIN=https://pavelmartynovlive-bit.github.io\n')
  out.write('DATABASE_PATH=/var/lib/home-sport/sessions.sqlite3\nHOST=127.0.0.1\nPORT=8787\n')
PY
install -m 0644 "$script_dir/home-sport.service" /etc/systemd/system/home-sport.service
systemctl daemon-reload
systemctl enable home-sport.service
systemctl restart home-sport.service
python3 - <<'PY'
import json,time,urllib.request
from pathlib import Path
port=8787
for line in Path('/etc/home-sport.env').read_text().splitlines():
 if line.startswith('PORT='):
  port=int(line.split('=',1)[1])
for attempt in range(30):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as response:
   if json.load(response).get('ok'):
    print(f'Backup API healthy on 127.0.0.1:{port}. Database and existing key preserved.')
    break
 except (OSError,ValueError):
  time.sleep(0.2)
else:
 raise SystemExit('API did not become healthy. Inspect: sudo journalctl -u home-sport -n 30')
PY
printf '%s\n' 'Next: configure HTTPS reverse proxy; see server/README.md.'
printf '%s\n' 'The personal key is in /etc/home-sport.env. Enter it on your phone; do not share it in chat.'
