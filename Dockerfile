FROM ghcr.io/foundry-rs/foundry:latest

COPY docker/entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
