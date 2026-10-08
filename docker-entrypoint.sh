#!/bin/sh
# Defaults for container use: configuration from /config/bello.config.yaml, reports to /reports.
# Explicit --config / --out on the command line win.
set -e
first="${1:-}"
case "$first" in
  ""|diff|vendors|setup|help|-h|--help|-v|--version) exec node /app/dist/cli/index.js "$@" ;;
esac
has_config=0
has_out=0
for a in "$@"; do
  case "$a" in
    --config|--config=*) has_config=1 ;;
    --out|--out=*) has_out=1 ;;
  esac
done
if [ "$has_config" = 0 ] && [ -f /config/bello.config.yaml ]; then
  set -- "$@" --config /config/bello.config.yaml
fi
if [ "$has_out" = 0 ]; then
  set -- "$@" --out /reports
fi
exec node /app/dist/cli/index.js "$@"
