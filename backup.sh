#!/bin/bash
set -euo pipefail

# RAYAT - Production database backup
# Required:
# - MYSQL_BACKUP_PWD or DB_PASSWORD available in the environment
# Optional overrides:
# - DB_HOST, DB_PORT, DB_USER, DB_NAME, BACKUP_DIR

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-rayat_db}"
DB_USER="${DB_USER:-root}"
BACKUP_DIR="${BACKUP_DIR:-/home/rayat/backups}"
MYSQL_BACKUP_PWD="${MYSQL_BACKUP_PWD:-${DB_PASSWORD:-}}"
DATE="$(date +%Y-%m-%d_%H-%M)"
BACKUP_FILE="$BACKUP_DIR/rayat_$DATE.sql.gz"

if [ -z "$MYSQL_BACKUP_PWD" ]; then
    echo "ERROR: set MYSQL_BACKUP_PWD or DB_PASSWORD before running backup.sh"
    exit 1
fi

if ! command -v mysqldump >/dev/null 2>&1; then
    echo "ERROR: mysqldump not found in PATH"
    exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

MYSQL_PWD="$MYSQL_BACKUP_PWD" mysqldump \
    -h "$DB_HOST" \
    -P "$DB_PORT" \
    -u "$DB_USER" \
    "$DB_NAME" \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    | gzip > "$BACKUP_FILE"

find "$BACKUP_DIR" -name 'rayat_*.sql.gz' -mtime +30 -delete

echo "Backup completed: $BACKUP_FILE"
