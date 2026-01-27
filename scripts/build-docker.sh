#!/bin/sh
set -eu

IMAGE_NAME="${ANVIL_IMAGE:-stablecoin-anvil}"

docker build -t "$IMAGE_NAME" .
