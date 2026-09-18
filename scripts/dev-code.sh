#!/usr/bin/env bash
# Launch VS Code with Harny loaded as an extension-development host.
# No F5 / Run-Debug needed.
#
# Usage:
#   scripts/dev-code.sh [folder-to-open] [--no-build]
#
# If no folder is given, an empty window is opened.
# If a folder is given, it is opened in the new dev window.
#
# Examples:
#   scripts/dev-code.sh
#   scripts/dev-code.sh ~/Projects/mio-progetto
#   OPENAI_API_KEY=sk-... scripts/dev-code.sh
#   HARNY_DEBUG=1 scripts/dev-code.sh
#
# Why a dedicated --user-data-dir:
#   On macOS the `code` CLI forwards args to the already-running instance,
#   which often ignores --extensionDevelopmentPath. Using an isolated
#   user-data-dir forces a fresh instance that actually loads Harny in dev mode.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DO_BUILD=1
TARGET_DIR=""
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) TARGET_DIR="$arg" ;;
  esac
done

VSCODE_APP="${VSCODE_APP:-/Applications/Visual Studio Code.app}"
VSCODE_BIN="$VSCODE_APP/Contents/MacOS/Code"
DEV_HOME="${HARNY_DEV_HOME:-$HOME/.harny-dev}"

if [ ! -x "$VSCODE_BIN" ]; then
  echo "VS Code non trovato in: $VSCODE_APP" >&2
  echo "Imposta VSCODE_APP=/percorso/... oppure installa VS Code." >&2
  exit 1
fi

if [ -n "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR" ]; then
  echo "Cartella da aprire inesistente: $TARGET_DIR" >&2
  exit 1
fi

if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> Build Harny ($REPO_DIR)"
  (cd "$REPO_DIR" && npm run build)
fi

mkdir -p "$DEV_HOME/user-data" "$DEV_HOME/extensions"

echo "==> Avvio VS Code + Harny (dev)${TARGET_DIR:+ su: $TARGET_DIR}"
exec "$VSCODE_BIN" \
  --user-data-dir="$DEV_HOME/user-data" \
  --extensions-dir="$DEV_HOME/extensions" \
  --extensionDevelopmentPath="$REPO_DIR" \
  --new-window \
  ${TARGET_DIR:+"$TARGET_DIR"}