#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CURSOR_DIR="${CURSOR_CONFIG_DIR:-$HOME/.cursor}"
CURSOR_SKILLS_DIR="$CURSOR_DIR/skills"
CURSOR_RULES_DIR="$CURSOR_DIR/rules"
CURSOR_COMMANDS_DIR="$CURSOR_DIR/commands"
CURSOR_AGENTS_DIR="$CURSOR_DIR/agents"
MCP_CONFIG="$CURSOR_DIR/mcp.json"
KEEP_DATA=false
KEEP_CONFIG=false
ASSUME_YES=false

usage() {
  cat <<'EOF'
Usage: scripts/uninstall.sh [options]

Default: stop Docker services, delete Docker volumes and memories, remove
agent-memory Cursor skills/rules/commands/agents, remove its MCP entry, and
delete local .env.

Options:
  --keep-data      Keep Docker volume and stored memories
  --keep-config    Keep local .env
  --yes            Skip destructive confirmation
  -h, --help       Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    --keep-data)
      KEEP_DATA=true
      ;;
    --keep-config)
      KEEP_CONFIG=true
      ;;
    --yes)
      ASSUME_YES=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$KEEP_DATA" != true && "$ASSUME_YES" != true ]]; then
  echo "WARNING: this deletes all agent-memory Docker volumes and stored memories."
  read -r -p 'Type DELETE to continue: ' confirmation
  if [[ "$confirmation" != "DELETE" ]]; then
    echo "Uninstall cancelled."
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Missing command: docker" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker unavailable. Start Docker Desktop, then rerun." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [[ "$KEEP_DATA" == true ]]; then
  docker compose down --remove-orphans
else
  docker compose down --volumes --remove-orphans
fi

for skill_name in memory-admin memory-capture memory-loop memory-recall; do
  rm -rf -- "$CURSOR_SKILLS_DIR/$skill_name"
done
echo "Removed agent-memory Cursor skills."
rm -f -- "$CURSOR_RULES_DIR/agent-memory.mdc"
echo "Removed agent-memory Cursor rules."
for command_name in memoried-loop-plan.md memoried-loop-start.md; do
  rm -f -- "$CURSOR_COMMANDS_DIR/$command_name"
done
echo "Removed agent-memory Cursor commands."
rm -f -- "$CURSOR_AGENTS_DIR/memoried-loop-worker.md"
echo "Removed agent-memory Cursor agents."

if [[ -f "$MCP_CONFIG" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$MCP_CONFIG" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    try:
        document = json.load(handle)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Cannot parse existing MCP config {path}: {error}")

if not isinstance(document, dict):
    raise SystemExit(f"MCP config must contain a JSON object: {path}")

servers = document.get("mcpServers")
if isinstance(servers, dict):
    servers.pop("agent-memory", None)

directory = os.path.dirname(path)
with tempfile.NamedTemporaryFile(
    "w", encoding="utf-8", dir=directory, delete=False
) as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")
    temporary_path = handle.name
os.replace(temporary_path, path)
PY
  elif command -v node >/dev/null 2>&1; then
    node - "$MCP_CONFIG" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [configPath] = process.argv.slice(2);
let document;
try {
  document = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  throw new Error(`Cannot parse existing MCP config ${configPath}: ${error.message}`);
}

if (!document || typeof document !== "object" || Array.isArray(document)) {
  throw new Error(`MCP config must contain a JSON object: ${configPath}`);
}
if (document.mcpServers && typeof document.mcpServers === "object") {
  delete document.mcpServers["agent-memory"];
}

const temporaryPath = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, configPath);
NODE
  else
    echo "No python3 or node; remove agent-memory from $MCP_CONFIG manually." >&2
  fi
  echo "Removed agent-memory Cursor MCP entry."
fi

if [[ "$KEEP_CONFIG" != true && -f .env ]]; then
  rm -f -- .env
  echo "Removed local .env."
fi

echo "Agent memory uninstalled."
