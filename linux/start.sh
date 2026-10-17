#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$base/dist/breakline-linux.cjs" "$@"
