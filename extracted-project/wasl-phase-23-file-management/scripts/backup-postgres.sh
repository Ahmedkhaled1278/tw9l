#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the PostgreSQL database to back up}"
UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
if [ ! -d "$UPLOAD_DIR" ]; then
  echo "Upload directory does not exist: $UPLOAD_DIR" >&2
  echo "Set UPLOAD_DIR to the application's actual upload directory." >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
DB_OUT="${BACKUP_DIR%/}/wasl-${STAMP}.dump"
FILES_OUT="${BACKUP_DIR%/}/wasl-${STAMP}.uploads.tar.gz"
MANIFEST="${BACKUP_DIR%/}/wasl-${STAMP}.sha256"
DB_TMP="${DB_OUT}.tmp"
FILES_TMP="${FILES_OUT}.tmp"
MANIFEST_TMP="${MANIFEST}.tmp"

# Never overwrite a previous recovery point, even if two runs share a timestamp.
for artifact in "$DB_OUT" "$FILES_OUT" "$MANIFEST" "$DB_TMP" "$FILES_TMP" "$MANIFEST_TMP"; do
  if [ -e "$artifact" ]; then
    echo "Backup artifact already exists; refusing to overwrite: $artifact" >&2
    exit 2
  fi
done

# If any step fails after publishing starts, remove only this run's incomplete set.
cleanup() {
  status=$?
  rm -f "$DB_TMP" "$FILES_TMP" "$MANIFEST_TMP"
  if [ "$status" -ne 0 ]; then
    rm -f "$DB_OUT" "$FILES_OUT" "$MANIFEST"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$DB_TMP"
tar -czf "$FILES_TMP" -C "$UPLOAD_DIR" .
chmod 600 "$DB_TMP" "$FILES_TMP"

# Publish data artifacts, then publish the manifest last as the completion marker.
mv "$DB_TMP" "$DB_OUT"
mv "$FILES_TMP" "$FILES_OUT"
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$DB_OUT")" "$(basename "$FILES_OUT")" > "$(basename "$MANIFEST_TMP")"
)
chmod 600 "$MANIFEST_TMP"
mv "$MANIFEST_TMP" "$MANIFEST"
chmod 600 "$DB_OUT" "$FILES_OUT" "$MANIFEST"

# The manifest is the final marker; clear the failure cleanup only after all outputs exist.
trap - EXIT HUP INT TERM
printf 'Database backup: %s\n' "$DB_OUT"
printf 'Uploaded files backup: %s\n' "$FILES_OUT"
printf 'Checksums: %s\n' "$MANIFEST"
printf '%s\n' 'Consistency note: pause writes or use a coordinated snapshot during backup to avoid DB/file timing mismatches.'
