#!/bin/bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

# Install Meta Wearables Web App AI development config into your project.
# Usage:
#   ./install-skills.sh              # Interactive menu (when run with a tty)
#   ./install-skills.sh claude       # Claude Code only
#   ./install-skills.sh cursor       # Cursor only
#   ./install-skills.sh copilot      # GitHub Copilot only
#   ./install-skills.sh agents       # AGENTS.md only
#   ./install-skills.sh all          # All tools
#   curl -sL ...install-skills.sh | bash   # Defaults to "all" (no tty)

set -euo pipefail

REPO="facebookincubator/meta-wearables-webapp"
BRANCH="main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
ARCHIVE_DIR="meta-wearables-webapp-${BRANCH}"
TEMP_DIR=""
EXTRACT_DIR=""

safe_cleanup() {
  if [ -z "${TEMP_DIR:-}" ]; then
    return 0
  fi
  if [[ ! "$(basename "$TEMP_DIR")" =~ ^meta-wearables-webapp\. ]]; then
    echo "Warning: TEMP_DIR does not match expected pattern, skipping cleanup." >&2
    return 0
  fi
  if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap safe_cleanup EXIT

download_archive() {
  if [ -z "${TEMP_DIR:-}" ]; then
    TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/meta-wearables-webapp.XXXXXX")"
    EXTRACT_DIR="${TEMP_DIR}/${ARCHIVE_DIR}"
    curl -sL "$ARCHIVE_URL" | tar xz -C "$TEMP_DIR" 2>/dev/null
  fi
}

install_claude() {
  echo "Installing Claude Code config for Meta Wearables Web Apps..."
  download_archive
  PLUGIN_DIR="${EXTRACT_DIR}/plugins/meta-wearables-webapp"
  if [ -d "${PLUGIN_DIR}/skills" ]; then
    mkdir -p .claude/skills
    cp -R "${PLUGIN_DIR}/skills/." .claude/skills/

    if [ -d "${PLUGIN_DIR}/references" ]; then
      mkdir -p .claude/references
      cp -R "${PLUGIN_DIR}/references/." .claude/references/
    fi

    echo "Installed .claude/ with $(find .claude -name '*.md' | wc -l | tr -d ' ') files."
  else
    echo "Error: Failed to download plugin content." >&2
    return 1
  fi
}

install_cursor() {
  echo "Installing Cursor plugin for Meta Wearables Web Apps..."
  download_archive
  PLUGIN_DIR="${EXTRACT_DIR}/plugins/meta-wearables-webapp"
  DEST="${HOME}/.cursor/plugins/local/meta-wearables-webapp"
  if [ -d "${PLUGIN_DIR}" ]; then
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    cp -R "${PLUGIN_DIR}" "$DEST"
    echo "Installed Cursor plugin to $DEST"
    echo "Restart Cursor (or run 'Developer: Reload Window') to pick up the plugin."
  else
    echo "Error: Failed to download plugin content." >&2
    return 1
  fi
}

install_copilot() {
  echo "Installing GitHub Copilot config for Meta Wearables Web Apps..."
  download_archive
  if [ -f "${EXTRACT_DIR}/.github/copilot-instructions.md" ]; then
    mkdir -p .github
    cp "${EXTRACT_DIR}/.github/copilot-instructions.md" .github/copilot-instructions.md
    echo "Installed .github/copilot-instructions.md."
  else
    echo "Error: Failed to download .github/copilot-instructions.md." >&2
    return 1
  fi
}

install_agents() {
  echo "Installing AGENTS.md..."
  download_archive
  if [ -f "${EXTRACT_DIR}/AGENTS.md" ]; then
    cp "${EXTRACT_DIR}/AGENTS.md" AGENTS.md
    echo "Installed AGENTS.md"
  else
    echo "Error: Failed to download AGENTS.md." >&2
    return 1
  fi
}

install_all() {
  local failed=0
  install_claude  || failed=1
  install_cursor  || failed=1
  install_copilot || failed=1
  install_agents  || failed=1
  if [ "$failed" -eq 1 ]; then
    return 1
  fi
}

show_menu() {
  echo ""
  echo "Meta Wearables Web App AI Config Installer"
  echo "==========================================="
  echo ""
  echo "Which tool do you want to install config for?"
  echo ""
  echo "  1) Claude Code    (.claude/)"
  echo "  2) Cursor         (~/.cursor/plugins/local/meta-wearables-webapp/)"
  echo "  3) GitHub Copilot (.github/copilot-instructions.md)"
  echo "  4) AGENTS.md      (universal — Codex, Gemini CLI, Devin, Windsurf, etc.)"
  echo "  5) All tools"
  echo "  6) Cancel"
  echo ""
  read -rp "Enter choice [1-6]: " choice
  case "$choice" in
    1) install_claude ;;
    2) install_cursor ;;
    3) install_copilot ;;
    4) install_agents ;;
    5) install_all ;;
    6) echo "Cancelled." ; exit 0 ;;
    *) echo "Invalid choice." >&2 ; exit 1 ;;
  esac
}

# Main
TOOL="${1:-}"

if [ -n "$TOOL" ]; then
  case "$TOOL" in
    claude)  install_claude ;;
    cursor)  install_cursor ;;
    copilot) install_copilot ;;
    agents)  install_agents ;;
    all)     install_all ;;
    *)       echo "Unknown tool: $TOOL. Use: claude, cursor, copilot, agents, or all." >&2 ; exit 1 ;;
  esac
elif [ -t 0 ]; then
  show_menu
else
  # Piped via curl — default to all
  install_all
fi

echo ""
echo "Your AI assistant will auto-discover the config when you open this project."
