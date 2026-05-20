#!/usr/bin/env sh
set -eu

dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec sh "$dir/install-harness.sh" all
