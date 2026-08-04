#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CURSOR_DIR="${CURSOR_CONFIG_DIR:-$HOME/.cursor}"
CURSOR_SKILLS_DIR="$CURSOR_DIR/skills"
CURSOR_RULES_DIR="$CURSOR_DIR/rules"
MEMORY_RULE_SOURCE="$PROJECT_ROOT/.cursor/rules/agent-memory.mdc"
MCP_CONFIG="$CURSOR_DIR/mcp.json"
MCP_URL="${MEMORY_MCP_URL:-http://127.0.0.1:8787/mcp}"
HEALTH_URL="${MEMORY_HEALTH_URL:-${MCP_URL%/mcp}/health}"
SKIP_MCP=false

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

Options:
  --skip-mcp    Install Docker service and skills, skip Cursor MCP config
  -h, --help    Show this help
EOF
}

for argument in "$@"; do
  case "$argument" in
    --skip-mcp)
      SKIP_MCP=true
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

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1" >&2
    exit 1
  fi
}

configure_mcp_with_python() {
  python3 - "$MCP_CONFIG" "$MCP_URL" <<'PY'
import json
import os
import sys
import tempfile

path, url = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(path), exist_ok=True)

if os.path.exists(path):
    with open(path, "r", encoding="utf-8") as handle:
        try:
            document = json.load(handle)
        except json.JSONDecodeError as error:
            raise SystemExit(f"Cannot parse existing MCP config {path}: {error}")
else:
    document = {}

if not isinstance(document, dict):
    raise SystemExit(f"MCP config must contain a JSON object: {path}")

servers = document.setdefault("mcpServers", {})
if not isinstance(servers, dict):
    raise SystemExit("MCP config field mcpServers must be a JSON object")

server = servers.get("agent-memory", {})
if not isinstance(server, dict):
    raise SystemExit("Existing agent-memory MCP entry must be a JSON object")

for key in ("command", "args", "env", "envFile"):
    server.pop(key, None)
server["url"] = url
servers["agent-memory"] = server

directory = os.path.dirname(path)
with tempfile.NamedTemporaryFile(
    "w", encoding="utf-8", dir=directory, delete=False
) as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")
    temporary_path = handle.name
os.replace(temporary_path, path)
PY
}

configure_mcp_with_node() {
  node - "$MCP_CONFIG" "$MCP_URL" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [configPath, url] = process.argv.slice(2);
fs.mkdirSync(path.dirname(configPath), { recursive: true });

let document = {};
if (fs.existsSync(configPath)) {
  try {
    document = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse existing MCP config ${configPath}: ${error.message}`);
  }
}

if (!document || typeof document !== "object" || Array.isArray(document)) {
  throw new Error(`MCP config must contain a JSON object: ${configPath}`);
}

const servers = document.mcpServers ?? {};
if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
  throw new Error("MCP config field mcpServers must be a JSON object");
}

const server = servers["agent-memory"] ?? {};
if (!server || typeof server !== "object" || Array.isArray(server)) {
  throw new Error("Existing agent-memory MCP entry must be a JSON object");
}

for (const key of ["command", "args", "env", "envFile"]) {
  delete server[key];
}
server.url = url;
servers["agent-memory"] = server;
document.mcpServers = servers;

const temporaryPath = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, configPath);
NODE
}

configure_mcp() {
  mkdir -p "$CURSOR_DIR"

  if command -v python3 >/dev/null 2>&1; then
    configure_mcp_with_python
  elif command -v node >/dev/null 2>&1; then
    configure_mcp_with_node
  else
    echo "No python3 or node; MCP config not changed." >&2
    echo "Add $MCP_URL to $MCP_CONFIG manually." >&2
    return 0
  fi

  echo "Configured Cursor MCP: $MCP_CONFIG"
}

require_command docker
require_command curl

if ! docker info >/dev/null 2>&1; then
  echo "Docker unavailable. Start Docker Desktop, then rerun." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

mkdir -p "$CURSOR_SKILLS_DIR" "$CURSOR_RULES_DIR"
for skill in .cursor/skills/*; do
  [[ -d "$skill" ]] || continue
  cp -R "$skill" "$CURSOR_SKILLS_DIR/"
done
echo "Installed Cursor skills: $CURSOR_SKILLS_DIR"
cp "$MEMORY_RULE_SOURCE" "$CURSOR_RULES_DIR/agent-memory.mdc"
echo "Installed Cursor rule: $CURSOR_RULES_DIR/agent-memory.mdc"

docker compose up -d --build

healthy=false
for _ in {1..30}; do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  echo "Memory service did not become healthy." >&2
  docker compose ps >&2
  exit 1
fi

if [[ "$SKIP_MCP" != true ]]; then
  configure_mcp
fi

echo
echo "Agent memory installed."
echo "MCP: $MCP_URL"
echo "Health: $HEALTH_URL"
echo "Stop: docker compose down"
echo "Keep data: do not use docker compose down -v"
