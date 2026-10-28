#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the target PostgreSQL database}"
: "${BACKUP_FILE:?Set BACKUP_FILE to a custom-format .dump file created by Wasl backup script}"
: "${UPLOADS_BACKUP_FILE:?Set UPLOADS_BACKUP_FILE to the matching .uploads.tar.gz file}"
: "${BACKUP_MANIFEST_FILE:?Set BACKUP_MANIFEST_FILE to the matching .sha256 manifest}"
UPLOAD_DIR="${UPLOAD_DIR:-./uploads}"

if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo 'Refusing to restore without CONFIRM_RESTORE=YES.' >&2
  echo 'WARNING: this operation cleans target database objects and restores uploaded files.' >&2
  exit 2
fi
[ -f "$BACKUP_FILE" ] || { echo "Database backup not found: $BACKUP_FILE" >&2; exit 2; }
[ -f "$UPLOADS_BACKUP_FILE" ] || { echo "Uploads backup not found: $UPLOADS_BACKUP_FILE" >&2; exit 2; }
[ -f "$BACKUP_MANIFEST_FILE" ] || { echo "Backup checksum manifest not found: $BACKUP_MANIFEST_FILE" >&2; exit 2; }

# Accept only the coordinated filenames emitted by backup-postgres.sh. This prevents
# accidentally mixing a database dump, uploads archive, and manifest from different runs.
DB_BASE="$(basename "$BACKUP_FILE")"
UPLOADS_BASE="$(basename "$UPLOADS_BACKUP_FILE")"
MANIFEST_BASE="$(basename "$BACKUP_MANIFEST_FILE")"
case "$DB_BASE" in
  wasl-????????T??????Z.dump) ;;
  *) echo 'Unexpected database backup filename; use a Wasl-generated backup.' >&2; exit 2 ;;
esac
STAMP="${DB_BASE#wasl-}"
STAMP="${STAMP%.dump}"
[ "$UPLOADS_BASE" = "wasl-${STAMP}.uploads.tar.gz" ] || { echo 'Database and uploads backup timestamps do not match.' >&2; exit 2; }
[ "$MANIFEST_BASE" = "wasl-${STAMP}.sha256" ] || { echo 'Checksum manifest timestamp does not match backups.' >&2; exit 2; }

# Require exactly the two expected checksum entries, then verify both before touching
# the database or upload directory. A checksum mismatch aborts the restore.
if ! awk -v db="$DB_BASE" -v up="$UPLOADS_BASE" '
  length($1) != 64 || $1 ~ /[^0-9a-f]/ || NF != 2 { bad=1 }
  $2 == db { db_count++ }
  $2 == up { up_count++ }
  END { if (bad || NR != 2 || db_count != 1 || up_count != 1) exit 1 }
' "$BACKUP_MANIFEST_FILE"; then
  echo 'Checksum manifest is malformed or does not match the selected backup pair.' >&2
  exit 2
fi
MANIFEST_DIR="$(dirname "$BACKUP_MANIFEST_FILE")"
(
  cd "$MANIFEST_DIR"
  sha256sum -c "$MANIFEST_BASE"
)

pg_restore --list "$BACKUP_FILE" >/dev/null
# Reject unsafe paths and all links/special entries before extraction. The uploads
# archive is expected to contain regular files and directories only.
tar -tzf "$UPLOADS_BACKUP_FILE" | awk '
  /^\// { print "Unsafe absolute path in uploads archive: " $0 > "/dev/stderr"; bad=1 }
  {
    n=split($0, parts, "/")
    for (i=1; i<=n; i++) if (parts[i]=="..") {
      print "Unsafe parent path in uploads archive: " $0 > "/dev/stderr"; bad=1
    }
  }
  END { if (bad) exit 1 }
'
tar -tvzf "$UPLOADS_BACKUP_FILE" | awk '
  substr($1,1,1) != "-" && substr($1,1,1) != "d" {
    print "Unsupported link or special entry in uploads archive: " $0 > "/dev/stderr"; bad=1
  }
  END { if (bad) exit 1 }
'

UPLOAD_PARENT="$(dirname "$UPLOAD_DIR")"
mkdir -p "$UPLOAD_PARENT"
STAGING_DIR="$(mktemp -d "$UPLOAD_PARENT/.wasl-restore.XXXXXX")"
PREVIOUS_UPLOADS="$STAGING_DIR/previous-uploads"
UPLOADS_STAGED="$STAGING_DIR/new-uploads"
UPLOADS_SWAPPED=0
HAD_PREVIOUS_UPLOADS=0

rollback_uploads() {
  status=$?
  if [ "$status" -ne 0 ] && { [ "$UPLOADS_SWAPPED" -eq 1 ] || [ "$HAD_PREVIOUS_UPLOADS" -eq 1 ]; }; then
    if [ "$UPLOADS_SWAPPED" -eq 1 ]; then rm -rf "$UPLOAD_DIR"; fi
    if [ "$HAD_PREVIOUS_UPLOADS" -eq 1 ] && [ -d "$PREVIOUS_UPLOADS" ]; then
      mv "$PREVIOUS_UPLOADS" "$UPLOAD_DIR" || echo 'CRITICAL: failed to roll back previous uploads directory.' >&2
    fi
  fi
  rm -rf "$STAGING_DIR"
  exit "$status"
}
trap rollback_uploads EXIT
trap 'exit 130' HUP INT TERM
mkdir -p "$UPLOADS_STAGED"
tar -xzf "$UPLOADS_BACKUP_FILE" --no-same-owner --no-same-permissions -C "$UPLOADS_STAGED"

# Replace the uploads tree instead of overlaying it: stale files from a newer snapshot
# must not survive a restore. Keep the prior tree until PostgreSQL restore succeeds.
if [ -e "$UPLOAD_DIR" ]; then
  [ -d "$UPLOAD_DIR" ] || { echo 'UPLOAD_DIR exists but is not a directory.' >&2; exit 2; }
  mv "$UPLOAD_DIR" "$PREVIOUS_UPLOADS"
  HAD_PREVIOUS_UPLOADS=1
fi
mv "$UPLOADS_STAGED" "$UPLOAD_DIR"
UPLOADS_SWAPPED=1

# Database restoration is destructive. If it fails, the EXIT trap restores the old
# uploads directory. PostgreSQL itself may still require recovery if pg_restore failed
# after making changes; do not reopen traffic until verification completes.
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --dbname="$DATABASE_URL" "$BACKUP_FILE"

UPLOADS_SWAPPED=0
rm -rf "$PREVIOUS_UPLOADS"
trap - EXIT HUP INT TERM
rm -rf "$STAGING_DIR"
printf '%s\n' 'Database restore command completed and uploaded files were replaced from the matching snapshot.'
printf '%s\n' 'Run smoke tests and verify attachment downloads before reopening traffic.'
printf '%s\n' 'If pg_restore fails, previous uploads are restored, but PostgreSQL may need recovery.'
