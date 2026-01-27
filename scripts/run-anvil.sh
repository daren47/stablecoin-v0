#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

# Load .env if present
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${RPC_URL:?Set RPC_URL in .env (see .env.example)}"

IMAGE_NAME="${ANVIL_IMAGE:-stablecoin-anvil}"
CONTAINER_NAME="${ANVIL_CONTAINER_NAME:-stablecoin-anvil}"
HOST_PORT="${ANVIL_HOST_PORT:-8545}"

# Clean up any old container with same name
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -it --rm \
  --name "$CONTAINER_NAME" \
  -p "${HOST_PORT}:8545" \
  -e RPC_URL="$RPC_URL" \
  -e FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-22876667}" \
  -e ANVIL_VERBOSITY="${ANVIL_VERBOSITY:--vvvv}" \
  "$IMAGE_NAME"
