#!/usr/bin/env bash
set -euo pipefail
LABEL="com.merados.apple-mail-auto"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "Uninstalled ${LABEL}"
