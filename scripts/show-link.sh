#!/bin/sh
# Print the share link for the key in .ferry-key. The key is placed after the
# URL fragment, so browsers never send it to the server and it is not written
# to access logs. Nothing is written to disk.
#
#   sh scripts/show-link.sh
#   sh scripts/show-link.sh <32-hex-file-id>
set -eu
cd "$(dirname "$0")/.."

if [ ! -f .ferry-key ]; then
  printf 'show-link: .ferry-key is missing; run npm run key:rotate\n' >&2
  exit 1
fi

key="$(tr -d '\r\n' < .ferry-key)"
if [ "${#key}" -lt 16 ]; then
  printf 'show-link: .ferry-key does not contain a usable key\n' >&2
  exit 1
fi

base="${FERRY_BASE_URL:-https://getferry.pages.dev}"

case "${1:-}" in
  "")
    printf '%s/#key=%s\n' "$base" "$key"
    ;;
  *)
    file="$1"
    if ! printf '%s' "$file" | grep -Eq '^[a-f0-9]{32}$'; then
      printf 'show-link: file id must be 32 lowercase hex characters\n' >&2
      exit 1
    fi
    printf '%s/#key=%s&file=%s\n' "$base" "$key" "$file"
    ;;
esac
