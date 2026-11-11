#!/bin/sh
# Enable the repository's versioned hooks. Run once per clone.
set -eu
cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit scripts/*.sh
printf 'install-hooks: core.hooksPath set to .githooks\n'
