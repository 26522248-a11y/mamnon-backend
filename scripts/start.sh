#!/bin/sh
# Production start (Render native runtime and Docker image).
#  - INITIAL_ADMIN_PASSWORD set → run migrations, then create the first admin ONCE (skipped when an admin exists;
#    weak passwords are refused and the deploy fails). Remove INITIAL_ADMIN_PASSWORD afterwards.
#  - The API itself applies pending migrations at boot when MIGRATIONS_RUN=true.
#  - Never seeds demo data (seed refuses NODE_ENV=production).
set -e
cd "$(dirname "$0")/.."
if [ -n "${UPLOAD_DIR:-}" ]; then mkdir -p "$UPLOAD_DIR"; fi
if [ -n "${AUDIT_LOG_DIR:-}" ]; then mkdir -p "$AUDIT_LOG_DIR"; fi
if [ -n "${INITIAL_ADMIN_PASSWORD:-}" ]; then
  node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
  node dist/database/bootstrap-admin.js
fi
exec node dist/main.js
