#!/bin/sh
# Daily backup: pg_dump (custom format) + uploads archive, with rotation.
# Keeps BACKUP_KEEP_DAILY daily (default 14), BACKUP_KEEP_WEEKLY Sunday copies (default 8), BACKUP_KEEP_MONTHLY 1st-of-month copies (default 12).
set -eu
DIR=/backups
STAMP=$(date +%Y-%m-%d_%H%M)
DOW=$(date +%u)   # 7 = Sunday
DOM=$(date +%d)
mkdir -p "$DIR/daily" "$DIR/weekly" "$DIR/monthly"

DB_FILE="$DIR/daily/mamnon_$STAMP.dump"
pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -Z 6 -f "$DB_FILE.tmp"
pg_restore -l "$DB_FILE.tmp" > /dev/null          # sanity check: dump is readable
mv "$DB_FILE.tmp" "$DB_FILE"

UP_FILE="$DIR/daily/uploads_$STAMP.tar.gz"
if [ -d /uploads ]; then tar -czf "$UP_FILE.tmp" -C /uploads . && mv "$UP_FILE.tmp" "$UP_FILE"; fi

[ "$DOW" = "7" ] && cp "$DB_FILE" "$DIR/weekly/" && { [ -f "$UP_FILE" ] && cp "$UP_FILE" "$DIR/weekly/" || true; }
[ "$DOM" = "01" ] && cp "$DB_FILE" "$DIR/monthly/" && { [ -f "$UP_FILE" ] && cp "$UP_FILE" "$DIR/monthly/" || true; }

rotate() { # dir keep
  for kind in mamnon uploads; do
    ls -1t "$1"/${kind}_* 2>/dev/null | tail -n +"$(( $2 + 1 ))" | xargs -r rm -f
  done
}
rotate "$DIR/daily"   "${BACKUP_KEEP_DAILY:-14}"
rotate "$DIR/weekly"  "${BACKUP_KEEP_WEEKLY:-8}"
rotate "$DIR/monthly" "${BACKUP_KEEP_MONTHLY:-12}"
echo "$(date -Iseconds) backup OK: $(basename "$DB_FILE") $(du -h "$DB_FILE" | cut -f1)"
