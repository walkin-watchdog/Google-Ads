#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

: "${VPS_HOST:?Set VPS_HOST to the VPS hostname or public IP.}"

VPS_USER="${VPS_USER:-ubuntu}"
VPS_PORT="${VPS_PORT:-22}"
VPS_PATH="${VPS_PATH:-/opt/google-ads-backend}"
VPS_ENV_FILE="${VPS_ENV_FILE:-.env.vps}"
REMOTE="${VPS_USER}@${VPS_HOST}"
SSH_OPTS=(-p "$VPS_PORT")
SCP_OPTS=(-P "$VPS_PORT")

if [[ -n "${VPS_SSH_KEY_PATH:-}" ]]; then
  SSH_OPTS+=(-i "$VPS_SSH_KEY_PATH")
  SCP_OPTS+=(-i "$VPS_SSH_KEY_PATH")
fi

echo "Deploying backend to ${REMOTE}:${VPS_PATH}"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$VPS_PATH'"

rsync -az --delete \
  -e "ssh -p $VPS_PORT${VPS_SSH_KEY_PATH:+ -i $VPS_SSH_KEY_PATH}" \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'client/config.js' \
  --exclude '*.log' \
  "$BACKEND_DIR/" "$REMOTE:$VPS_PATH/"

if [[ -f "$BACKEND_DIR/$VPS_ENV_FILE" ]]; then
  echo "Uploading $VPS_ENV_FILE as remote .env.vps"
  scp "${SCP_OPTS[@]}" "$BACKEND_DIR/$VPS_ENV_FILE" "$REMOTE:$VPS_PATH/.env.vps"
else
  echo "No local $VPS_ENV_FILE found; using remote .env.vps if it already exists."
fi

ssh "${SSH_OPTS[@]}" "$REMOTE" "
  set -euo pipefail
  cd '$VPS_PATH'
  test -f .env.vps || { echo 'Missing .env.vps on VPS.' >&2; exit 1; }
  docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --build
  docker image prune -f >/dev/null
  docker compose --env-file .env.vps -f docker-compose.vps.yml ps
"
