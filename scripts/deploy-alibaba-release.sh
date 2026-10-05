#!/usr/bin/env bash
# Usage: deploy-alibaba-release.sh RELEASE_NAME ARCHIVE_SHA256
# Archive must already be uploaded to /tmp/RELEASE_NAME.tgz.
set -euo pipefail
name="${1:?release name required}"
expected="${2:?archive SHA256 required}"
[[ "$name" =~ ^[0-9]{8}-[0-9]{4}-[a-z0-9-]+$ && "$expected" =~ ^[a-f0-9]{64}$ ]]
base=/opt/international-tms
release="$base/releases/$name"
archive="/tmp/$name.tgz"
backup="$base/backups/$name"
previous="$(readlink -f "$base/current")"
[[ "$previous" == "$base/releases/"* && -d "$previous" && ! -e "$release" ]]
test "$(sha256sum "$archive" | cut -d ' ' -f1)" = "$expected"
stopped=0
switched=0
env_changed=0
rollback() {
  code=$?
  trap - ERR
  if [[ "$switched" == 1 ]]; then
    ln -sfn "$previous" "$base/current.rollback"
    mv -Tf "$base/current.rollback" "$base/current"
  fi
  if [[ "$env_changed" == 1 ]]; then
    cp "$backup/runtime.env" /etc/international-tms/international-tms.env
  fi
  if [[ "$stopped" == 1 ]]; then systemctl restart international-tms.service || true; fi
  echo "Deployment failed; previous app restored. Database backup: $backup/database.sql.gz" >&2
  exit "$code"
}
trap rollback ERR
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
test -s "$release/build/server/index.js"
test -s "$release/production/server.mjs"
test -s "$release/scripts/migrate-mysql.mjs"
export PATH="$base/shared/node/bin:$PATH"
cd "$release"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R international-tms:international-tms "$release"
node --check production/server.mjs
node --check build/server/index.js
runuser -u international-tms -- env PATH="$PATH" node --input-type=module -e "await import('@react-router/node');await import('./production/mysql-migrations.mjs');await import('./build/server/index.js');console.log('Release imports passed')"

mkdir -p "$backup"
chmod 700 "$base/backups" "$backup"
cp /etc/international-tms/international-tms.env "$backup/runtime.env"
chmod 600 "$backup/runtime.env"
set -a
. /etc/international-tms/international-tms.env
set +a
systemctl stop international-tms.service
stopped=1
node scripts/deploy-data-integrity.mjs > "$backup/core-before.json"
export MYSQL_PWD="$MYSQL_PASSWORD"
timeout 180 mysqldump --host="$MYSQL_HOST" --port="${MYSQL_PORT:-3306}" --user="$MYSQL_USER" \
  --single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob --triggers \
  "$MYSQL_DATABASE" | gzip > "$backup/database.sql.gz"
unset MYSQL_PWD
chmod 600 "$backup/database.sql.gz"
test -s "$backup/database.sql.gz"
gzip -t "$backup/database.sql.gz"
sha256sum "$backup/database.sql.gz" > "$backup/database.sha256"

if [[ -z "${BOOTSTRAP_TOKEN:-}" ]]; then
  # Never print or send the scheduler credential to the client.
  node --input-type=module -e "import{randomBytes}from'node:crypto';import{appendFileSync}from'node:fs';appendFileSync('/etc/international-tms/international-tms.env','\\nBOOTSTRAP_TOKEN='+randomBytes(32).toString('hex')+'\\n');"
  env_changed=1
  set -a
  . /etc/international-tms/international-tms.env
  set +a
fi
runtime_env=("PATH=$PATH" "MYSQL_HOST=$MYSQL_HOST" "MYSQL_PORT=${MYSQL_PORT:-3306}" "MYSQL_DATABASE=$MYSQL_DATABASE" "MYSQL_USER=$MYSQL_USER" "MYSQL_PASSWORD=$MYSQL_PASSWORD" "MYSQL_SSL_MODE=${MYSQL_SSL_MODE:-preferred}")
runuser -u international-tms -- env "${runtime_env[@]}" node scripts/migrate-mysql.mjs
runuser -u international-tms -- env "${runtime_env[@]}" node scripts/verify-mysql-runtime.mjs
node scripts/deploy-data-integrity.mjs "$backup/core-before.json"
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
systemctl restart international-tms.service
systemctl is-active --quiet international-tms.service
healthy=0
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 5 http://127.0.0.1:3100/readyz > "$backup/readiness.json" && \
     curl -fsS --max-time 10 https://tms.shxlh.com/login > "$backup/login.html"; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
stopped=0
switched=0
env_changed=0
trap - ERR
printf 'RELEASE=%s\nPREVIOUS=%s\nBACKUP=%s\n' "$release" "$previous" "$backup/database.sql.gz"
cat "$backup/readiness.json"
echo
