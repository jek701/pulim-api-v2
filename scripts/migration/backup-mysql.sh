#!/usr/bin/env bash
# Run as the MySQL socket operator. No application secrets in command arguments.
set -euo pipefail
umask 077
pulim_backup_root=${PULIM_BACKUP_DIR:-/root/pulim-backups/mysql}
pulim_backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
pulim_backup_run="$pulim_backup_root/$pulim_backup_stamp"
mkdir -p "$pulim_backup_root"
chmod 700 "$pulim_backup_root"
mkdir -m 700 "$pulim_backup_run"
for pulim_schema in pulim_app pulim_db; do
  mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF "$pulim_schema" \
    | gzip > "$pulim_backup_run/$pulim_schema.sql.gz.partial"
  gzip -t "$pulim_backup_run/$pulim_schema.sql.gz.partial"
  mv "$pulim_backup_run/$pulim_schema.sql.gz.partial" "$pulim_backup_run/$pulim_schema.sql.gz"
done
(cd "$pulim_backup_run" && sha256sum ./*.sql.gz > SHA256SUMS)
printf '%s\n' "MySQL backups completed: $pulim_backup_run"
# Retention is deliberately explicit; first deployment keeps every backup.
# Set PULIM_BACKUP_RETENTION_DAYS after reviewing disk use and recovery requirements.
if [[ ${PULIM_BACKUP_RETENTION_DAYS:-} =~ ^[0-9]+$ ]] && (( PULIM_BACKUP_RETENTION_DAYS >= 30 )); then
  find "$pulim_backup_root" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' \
    -mtime "+$PULIM_BACKUP_RETENTION_DAYS" -exec rm -rf -- {} +
fi
