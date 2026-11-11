#!/bin/sh
# Fail if a likely secret is about to be committed or already tracked.
#
#   sh scripts/check-secrets.sh          # scan tracked files
#   sh scripts/check-secrets.sh --staged # scan only staged changes
#   sh scripts/check-secrets.sh --all    # scan every file, including untracked
#
# The scan is intentionally conservative: it looks for credential shapes and
# for the two local secret files. It never prints the value it matched.
set -eu
cd "$(dirname "$0")/.."

mode="${1:-tracked}"

fail=0
report() {
  printf 'secret-scan: %s\n' "$1" >&2
  fail=1
}

# Secret files must never be part of the repository, even when .gitignore
# would normally hide them.
for forbidden in .ferry-key .dev.vars; do
  if git ls-files --error-unmatch "$forbidden" >/dev/null 2>&1; then
    report "$forbidden is tracked by git"
  fi
done

list_files() {
  case "$mode" in
    --staged)
      git diff --cached --name-only --diff-filter=ACMR
      ;;
    --all)
      find . \
        -path ./.git -prune -o \
        -path ./node_modules -prune -o \
        -path ./target -prune -o \
        -path ./.wrangler -prune -o \
        -type f -print | sed 's|^\./||'
      ;;
    *)
      git ls-files
      ;;
  esac
}

# Shapes that are secrets in practice, not documentation placeholders.
patterns='(FERRY_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9._-]{16,})|(AWS_SECRET_ACCESS_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{20,})|(AWS_ACCESS_KEY_ID[[:space:]]*=[[:space:]]*AKIA[0-9A-Z]{16})|(gh[pousr]_[A-Za-z0-9]{30,})|(github_pat_[A-Za-z0-9_]{30,})|(-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)|(-----BEGIN PGP PRIVATE KEY BLOCK-----)|(sk-[A-Za-z0-9]{32,})|(xox[baprs]-[A-Za-z0-9-]{10,})|([A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,})'

list_files | while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in
    .ferry-key|.dev.vars|*-lock.json|package-lock.json) continue ;;
  esac
  if grep -Iq . "$file" 2>/dev/null; then
    if grep -IEn "$patterns" "$file" >/dev/null 2>&1; then
      report "possible credential in $file"
    fi
  fi
done

if [ "$fail" -ne 0 ]; then
  printf 'secret-scan: FAILED\n' >&2
  exit 1
fi

printf 'secret-scan: clean (%s)\n' "$mode"
