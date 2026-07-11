#!/bin/bash
# Modal container entry: Litestream-replicated SQLite on LOCAL disk, everything
# else durable on Modal Volumes. Layout decisions (see docs/desktop_plan.md +
# oracle findings): the live DB must NOT sit on a network volume; Pi's session
# JSONL + config must survive restarts, so /var/lib/agena is a Volume with db/
# symlinked out to container-local disk.
set -euo pipefail

# Modal cannot mount a Volume over the image-owned /home/agena directory.
# Keep HOME stable while the physical persistent mount stays under /mnt.
rm -rf /home/agena
ln -s /mnt/agena-home /home/agena
chmod 700 /mnt/agena-home
touch /run/agena-runtime

LOCAL_DB_DIR=/root/agena-db
DB_PATH="$LOCAL_DB_DIR/agena.db"
mkdir -p "$LOCAL_DB_DIR"

# db/ on the state volume → symlink to local disk (migrate any stray real dir)
if [ -d /var/lib/agena/db ] && [ ! -L /var/lib/agena/db ]; then
  rm -rf /var/lib/agena/db
fi
ln -sfn "$LOCAL_DB_DIR" /var/lib/agena/db

cat > /root/litestream.yml <<YAML
access-key-id: ${LITESTREAM_ACCESS_KEY_ID}
secret-access-key: ${LITESTREAM_SECRET_ACCESS_KEY}
dbs:
  - path: ${DB_PATH}
    replicas:
      - type: s3
        bucket: ${R2_BUCKET}
        path: agena.db
        endpoint: ${R2_ENDPOINT}
        region: auto
YAML

echo "[entry] restoring db from R2 (if replica exists)"
litestream restore -config /root/litestream.yml -if-replica-exists -if-db-not-exists "$DB_PATH"

if [ -f "$DB_PATH" ]; then
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const row = db.prepare('PRAGMA integrity_check').get();
    const ok = row && Object.values(row)[0] === 'ok';
    console.log('[entry] integrity_check:', ok ? 'ok' : JSON.stringify(row));
    process.exit(ok ? 0 : 1);
  " "$DB_PATH"
else
  echo "[entry] no db yet — fresh workspace"
fi

# Litestream requires WAL (store defaults to rollback journal locally)
export AGENA_SQLITE_JOURNAL=wal

# Modal injects AWS_* infra credentials; Pi's provider scan routes claude-*
# models to Bedrock when it sees them (UnrecognizedClientException 403).
# Anthropic API is our provider; Litestream uses explicit config-file creds.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION \
  AWS_DEFAULT_REGION AWS_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_BEARER_TOKEN_BEDROCK || true
# Belt and braces: pin the default model to the Anthropic API regardless of
# what Pi's own scan or a stale pi/auth.json thinks is available.
export AGENA_PI_DEFAULT_MODEL="anthropic/claude-sonnet-5"

echo "[entry] starting litestream + daemon"
exec litestream replicate -config /root/litestream.yml -exec "node /app/apps/daemon/src/main.ts"
