#!/usr/bin/env bash
# Install LaunchAgent: apple-mail-auto every 15 minutes (MAX automation).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
AUTO_JS="$ROOT/build/auto.js"
LABEL="com.merados.apple-mail-auto"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SUPPORT="$HOME/Library/Application Support/apple-mail-mcp"
LOG="$SUPPORT/auto-launchd.log"
INTERVAL="${INTERVAL_SEC:-1200}"  # 20 min (avoid Mail.app thrash)

if [[ ! -x "$NODE" ]]; then
  echo "node not found" >&2
  exit 1
fi

if [[ ! -f "$AUTO_JS" ]]; then
  echo "Building auto.js…"
  (cd "$ROOT" && pnpm run build)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$SUPPORT"

# Default max-auto config if missing
if [[ ! -f "$SUPPORT/auto-config.json" ]]; then
  cat > "$SUPPORT/auto-config.json" <<'JSON'
{
  "limit": 60,
  "bodyLimit": 12,
  "actionExecuteLimit": 20,
  "aggressive": true,
  "learn": true,
  "learnEveryNRuns": 1,
  "sort": true,
  "newsletters": false,
  "newsletterMinCount": 3,
  "newsletterDays": 90,
  "actions": true,
  "neverAutoSend": true,
  "_comment": "Files into On My Mac. newsletters off (slow). neverAutoSend enforced."
}
JSON
fi

# Load XAI key from shell profile if present (LaunchAgents get minimal env)
ENV_XAI=""
if [[ -n "${XAI_API_KEY:-}" ]]; then
  ENV_XAI="$XAI_API_KEY"
elif [[ -f "$HOME/.zshrc" ]]; then
  ENV_XAI=$(grep -E '^\s*export XAI_API_KEY=' "$HOME/.zshrc" 2>/dev/null | tail -1 | sed 's/.*XAI_API_KEY=//;s/[\"'\'']//g' || true)
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${AUTO_JS}</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
$(if [[ -n "$ENV_XAI" ]]; then printf '    <key>XAI_API_KEY</key>\n    <string>%s</string>\n' "$ENV_XAI"; fi)
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl start "$LABEL" 2>/dev/null || true

echo "Installed ${LABEL}"
echo "  plist:    $PLIST"
echo "  interval: ${INTERVAL}s"
echo "  binary:   $NODE $AUTO_JS"
echo "  log:      $LOG"
echo "  config:   $SUPPORT/auto-config.json"
echo ""
echo "Commands:"
echo "  launchctl print gui/\$(id -u)/${LABEL}"
echo "  tail -f \"$LOG\""
echo "  $NODE $AUTO_JS --dry-run"
echo "  $ROOT/scripts/uninstall-auto-agent.sh"
