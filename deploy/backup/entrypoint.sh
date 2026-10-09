#!/bin/sh
# Runs backup.sh every day at BACKUP_TIME (HH:MM, container TZ = Asia/Ho_Chi_Minh). No cron daemon needed.
set -eu
: "${BACKUP_TIME:=02:30}"
echo "backup scheduler: daily at $BACKUP_TIME ($(date +%Z))"
[ "${BACKUP_ON_START:-false}" = "true" ] && /usr/local/bin/backup.sh || true
while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%F) $BACKUP_TIME" +%s 2>/dev/null || date -D '%Y-%m-%d %H:%M' -d "$(date +%F) $BACKUP_TIME" +%s)
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  sleep $(( next - now ))
  /usr/local/bin/backup.sh || echo "$(date -Iseconds) BACKUP FAILED" >&2
done
