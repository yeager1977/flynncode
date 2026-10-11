#!/usr/bin/env bash
# Residue audit for the flynncode rename. Run with an optional pass label.
set -u
cd "$(dirname "$0")/.."

EXCL=(--exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=.turbo --exclude-dir=.git --exclude=bun.lock --exclude=rename-audit.sh)

label=${1:-baseline}
echo "=== rename audit: $label ==="
for pat in '@opencode-ai/' '^const app = "opencode"' 'packages/opencode' '\.opencode' 'opencode\.json' '~/.config/opencode' '~/.local/share/opencode' 'opencode\.ai' '"OpenCode"' 'ai\.opencode' 'OPENCODE_[A-Z]+' 'productName: "opencode"' 'schemes: \["opencode"\]'; do
  n=$(grep -rE --color=never "${pat}" . "${EXCL[@]}" -l 2>/dev/null | wc -l)
  printf '%-40s %s files\n' "$pat" "$n"
done
echo "done"