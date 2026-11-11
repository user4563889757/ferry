#!/bin/sh
# Generate a new share key, store it locally with tight permissions, and push
# it to Cloudflare as the Pages secret. The key is never printed.
#
#   sh scripts/rotate-key.sh            # rotate local + Cloudflare production
#   sh scripts/rotate-key.sh --local    # rotate only the local files
#
# After rotating production, the old key stops working immediately. Anyone who
# already has a session cookie issued with the old key is also logged out,
# because the session HMAC is derived from FERRY_KEY.
set -eu
cd "$(dirname "$0")/.."

local_only=0
if [ "${1:-}" = "--local" ]; then
  local_only=1
fi

umask 077

if command -v openssl >/dev/null 2>&1; then
  key="$(openssl rand -hex 32)"
else
  key="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi

if [ "${#key}" -ne 64 ]; then
  printf 'rotate-key: could not generate a 32-byte key\n' >&2
  exit 1
fi

printf '%s\n' "$key" > .ferry-key
chmod 600 .ferry-key

if [ -f .dev.vars ]; then
  tmp="$(mktemp)"
  if grep -q '^FERRY_KEY=' .dev.vars; then
    sed "s|^FERRY_KEY=.*|FERRY_KEY=$key|" .dev.vars > "$tmp"
  else
    cat .dev.vars > "$tmp"
    printf 'FERRY_KEY=%s\n' "$key" >> "$tmp"
  fi
  mv "$tmp" .dev.vars
  chmod 600 .dev.vars
fi

if [ "$local_only" -eq 1 ]; then
  printf 'rotate-key: local key rotated (not printed)\n'
  exit 0
fi

if ! command -v npx >/dev/null 2>&1; then
  printf 'rotate-key: npx is required to update the Cloudflare secret\n' >&2
  exit 1
fi

printf '%s' "$key" | npx wrangler pages secret put FERRY_KEY --project-name getferry >/dev/null
printf 'rotate-key: local and Cloudflare keys rotated (not printed)\n'
printf 'rotate-key: redeploy so the new binding is used, then run npm run link\n'
