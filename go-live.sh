#!/bin/bash
set -euo pipefail

# RAYAT - Production go-live helper
# Manual prerequisites:
# 1. Upload the project to the server
# 2. Create backend/.env on the server from backend/.env.example
# 3. Fill real DB, JWT, SMTP, and app URL values before running this script

APP_ROOT="${APP_ROOT:-/home/rayat}"
BACKEND_DIR="${BACKEND_DIR:-$APP_ROOT/backend}"
BACKUP_DIR="${BACKUP_DIR:-$APP_ROOT/backups}"
BACKUP_SCRIPT_SOURCE="${BACKUP_SCRIPT_SOURCE:-$APP_ROOT/backup.sh}"
BACKUP_SCRIPT_TARGET="${BACKUP_SCRIPT_TARGET:-$APP_ROOT/backup_exec.sh}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$APP_ROOT/.backup.env}"
PM2_APP_NAME="${PM2_APP_NAME:-rayat}"

echo "Starting Rayat production go-live..."

if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo "ERROR: $BACKEND_DIR/.env not found."
    echo "Create it from backend/.env.example and fill real production values first."
    exit 1
fi

if [ -z "${MYSQL_BACKUP_PWD:-}" ] && [ ! -f "$BACKUP_ENV_FILE" ]; then
    read -r -s -p "MySQL backup password: " MYSQL_BACKUP_PWD
    echo
fi

if [ -n "${MYSQL_BACKUP_PWD:-}" ] && [ ! -f "$BACKUP_ENV_FILE" ]; then
    umask 177
    printf 'export MYSQL_BACKUP_PWD=%q\n' "$MYSQL_BACKUP_PWD" > "$BACKUP_ENV_FILE"
    chmod 600 "$BACKUP_ENV_FILE"
fi

if [ ! -f "$BACKUP_ENV_FILE" ]; then
    echo "ERROR: backup credentials file not found."
    echo "Set MYSQL_BACKUP_PWD before running or create $BACKUP_ENV_FILE manually."
    exit 1
fi

echo "Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --omit=dev

echo "Installing PM2 and starting backend..."
npm install -g pm2
pm2 start server.js --name "$PM2_APP_NAME" --update-env
pm2 save
pm2 startup

echo "Preparing backup script..."
mkdir -p "$BACKUP_DIR"
install -m 700 "$BACKUP_SCRIPT_SOURCE" "$BACKUP_SCRIPT_TARGET"

echo "Configuring nightly backup cron..."
CRON_TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$BACKUP_SCRIPT_TARGET" > "$CRON_TMP" || true
printf '0 3 * * * . "%s" && "%s" >> "%s/backup.log" 2>&1\n' "$BACKUP_ENV_FILE" "$BACKUP_SCRIPT_TARGET" "$BACKUP_DIR" >> "$CRON_TMP"
crontab "$CRON_TMP"
rm -f "$CRON_TMP"

echo "Rayat go-live setup completed."
echo "Post-deploy checks:"
echo "- verify https://your-domain.com/privacy"
echo "- verify https://your-domain.com/terms"
echo "- test admin login"
echo "- test forgot-password email delivery"
