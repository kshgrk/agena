#!/bin/bash
set -euo pipefail

DB_DIR=/var/lib/agena/db
DB_PATH="$DB_DIR/agena.db"

# Modal kept db/ as a symlink to container-local storage. The VM keeps the DB
# directly on its persistent local-NVMe-backed state volume.
if [ -L "$DB_DIR" ]; then
  rm "$DB_DIR"
fi
mkdir -p "$DB_DIR"

CONFIG=$(mktemp)
chmod 600 "$CONFIG"
trap 'rm -f "$CONFIG"' EXIT
cat > "$CONFIG" <<YAML
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
litestream restore -config "$CONFIG" -if-replica-exists -if-db-not-exists "$DB_PATH"

if [ -f "$DB_PATH" ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const row = db.prepare("PRAGMA integrity_check").get();
    const ok = row && Object.values(row)[0] === "ok";
    console.log("[entry] integrity_check:", ok ? "ok" : JSON.stringify(row));
    process.exit(ok ? 0 : 1);
  ' "$DB_PATH"
fi

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION \
  AWS_DEFAULT_REGION AWS_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE \
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
  AWS_BEARER_TOKEN_BEDROCK || true

echo "[entry] starting litestream + daemon"
exec litestream replicate -config "$CONFIG" -exec "node /app/apps/daemon/src/main.ts"
