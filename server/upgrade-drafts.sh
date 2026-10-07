#!/usr/bin/env bash
# Run only on the existing Ubuntu/Debian VPS: sudo bash server/upgrade-drafts.sh
# Updates API code; preserves the key, database, systemd configuration and nginx.
set -euo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo on the VPS, not on Mac.' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
api_path=/opt/home-sport/server/server.py
[[ -f "$api_path" && -f /etc/home-sport.env ]] || { echo 'Existing installation not found.' >&2; exit 1; }
systemctl is-active --quiet home-sport
service_command="$(systemctl show home-sport -p ExecStart --value)"
[[ "$service_command" == *"$api_path"* ]] || { echo 'Service uses another API path; review configuration first.' >&2; exit 1; }
python3 -m py_compile "$script_dir/server.py"
backup_dir="/var/backups/home-sport/deploy-$(date -u +%Y%m%d-%H%M%S)-$$"
install -d -m 0700 "$backup_dir"
install -m 0600 "$api_path" "$backup_dir/server.py"
# Read only the database path; never print or source the token-containing env file.
python3 - "$script_dir/backup.py" "$backup_dir/history.sqlite3" <<'PY'
import subprocess,sys
from pathlib import Path
settings={}
for line in Path('/etc/home-sport.env').read_text().splitlines():
 if line and not line.startswith('#') and '=' in line:
  key,value=line.split('=',1); settings[key]=value.strip().strip('"').strip("'")
database=settings.get('DATABASE_PATH','/var/lib/home-sport/sessions.sqlite3')
if not Path(database).is_absolute() or not Path(database).is_file():
 raise SystemExit('Database path invalid; no code changed.')
subprocess.run([sys.executable,sys.argv[1],database,sys.argv[2]],check=True)
PY
code_changed=false
rollback() {
  if [[ "$code_changed" == true ]]; then
    install -m 0644 "$backup_dir/server.py" "$api_path"
    systemctl restart home-sport || true
    echo 'Upgrade failed. Previous API code restored; database preserved.' >&2
  fi
}
trap rollback ERR
install -m 0644 "$script_dir/server.py" "${api_path}.new"
mv "${api_path}.new" "$api_path"
code_changed=true
systemctl restart home-sport
python3 - <<'PY'
import json,time,urllib.request
from pathlib import Path
port=8787
for line in Path('/etc/home-sport.env').read_text().splitlines():
 if line.startswith('PORT='): port=int(line.split('=',1)[1].strip().strip('"').strip("'"))
for attempt in range(30):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as response:
   data=json.load(response)
   if data.get('ok') and data.get('draft') is True:
    print('Updated API healthy; draft capability enabled.'); break
 except (OSError,ValueError): time.sleep(0.2)
else: raise SystemExit('Updated API did not become healthy.')
PY
trap - ERR
printf 'Database snapshot and previous API code saved in %s\n' "$backup_dir"
printf '%s\n' 'Next: verify HTTPS health, authenticated draft GET and snapshot timer; do not replace user draft with test data.'
