#!/usr/bin/env bash
# Build apple-mail-ai (on-device Foundation Models helper)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${ROOT}/../build/apple-mail-ai"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"
if [[ ! -d "$DEVELOPER_DIR" ]]; then
  DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
fi
export DEVELOPER_DIR
cd "$ROOT"
swift build -c release --product apple-mail-ai
BIN="$(swift build -c release --show-bin-path)/apple-mail-ai"
mkdir -p "$(dirname "$OUT")"
cp -f "$BIN" "$OUT"
chmod +x "$OUT"
echo "built: $OUT"
"$OUT" status || true
