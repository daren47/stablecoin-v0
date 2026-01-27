#!/bin/sh
set -eu

# Required
: "${RPC_URL:?Set RPC_URL (e.g. https://mainnet.infura.io/v3/KEY)}"

ANVIL_VERBOSITY="${ANVIL_VERBOSITY:--vvvv}"
FORK_BLOCK_NUMBER="${FORK_BLOCK_NUMBER:-22876667}"

exec anvil $ANVIL_VERBOSITY --host 0.0.0.0 --chain-id 1 --fork-url "$RPC_URL" --fork-block-number "$FORK_BLOCK_NUMBER"
