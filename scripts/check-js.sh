#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

find web functions tests -type f -name '*.js' -print0 |
  while IFS= read -r -d '' file; do
    node --check "$file"
  done
