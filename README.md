# Agent Memory

Private, local-first memory for Cursor agents.

Agent Memory gives Cursor a durable memory layer without sending your memories
to a hosted service. It runs locally with PostgreSQL and exposes an MCP server
over HTTP.

## Features

- Global, repository, and conversation-scoped memories
- Full-text and fuzzy search with PostgreSQL
- Durable loop state and resumable checkpoints
- Secret redaction before persistence
- Persistent Docker volume for local data
- Session memory and loop retention controls
- Lifetime usage counters with a readable report

## Quick start

### Requirements

- macOS or Linux
- Docker Desktop with Docker Compose
- Cursor
- `curl` and `tar`
- Python 3 or Node.js for automatic Cursor configuration

Node.js and npm are not required to run the service. Docker builds and runs the
application.

### Install without cloning

Download the latest source archive into a stable local directory and run the
installer:

```bash
INSTALL_DIR="${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}"
mkdir -p "$INSTALL_DIR"
curl -fsSL \
  https://github.com/orisilber/agent-memory/archive/refs/heads/main.tar.gz \
  | tar -xzf - --strip-components=1 -C "$INSTALL_DIR"
"$INSTALL_DIR/scripts/install.sh"
```

The installer:

1. Creates local configuration from `.env.example`.
2. Builds and starts the Docker services.
3. Installs Agent Memory skills and rules globally for Cursor.
4. Adds the MCP server to `~/.cursor/mcp.json`.
5. Waits for the health endpoint.

The default installation directory keeps the Compose project and its database
volume stable across updates. Use `--skip-mcp` to leave Cursor configuration
unchanged:

```bash
"${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}/scripts/install.sh" \
  --skip-mcp
```

Verify the service:

```bash
curl --fail http://127.0.0.1:8787/health
```

MCP endpoint: `http://127.0.0.1:8787/mcp`.

### Update

Run the archive download again, then rerun the installer:

```bash
INSTALL_DIR="${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}"
curl -fsSL \
  https://github.com/orisilber/agent-memory/archive/refs/heads/main.tar.gz \
  | tar -xzf - --strip-components=1 -C "$INSTALL_DIR"
"$INSTALL_DIR/scripts/install.sh"
```

Updates rebuild the application without removing the database volume.

## Configuration

Configuration lives in `$AGENT_MEMORY_HOME/.env`, or
`$HOME/.local/share/agent-memory/.env` when using the default installation.

Common settings:

- `MEMORY_OWNER_ID`: owner namespace for stored memories.
- `MEMORY_API_KEY`: optional API key for the local HTTP endpoint.
- `SESSION_RETENTION_DAYS`: retention period for session memories and loops.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: database credentials and
  name.
- `POSTGRES_PORT`: host port for PostgreSQL; defaults to `5433`.

The service binds to localhost. Keep it local unless you have explicitly
configured authentication and network protection. Never commit `.env`.

If `MEMORY_API_KEY` is set, configure the same bearer token in Cursor. See
[`docs/cursor-setup.md`](docs/cursor-setup.md) for the authenticated MCP
configuration.

## Use

The installer registers these MCP tools:

Memory:

- `memory_session_start`
- `memory_search`
- `memory_store`
- `memory_update`
- `memory_archive`
- `memory_forget`
- `memory_list`

Durable loops:

- `loop_start`
- `loop_checkpoint`
- `loop_resume`
- `loop_finish`

Memory scopes:

- `global`: reusable personal preferences and procedures.
- `repo`: project conventions and decisions identified by repository.
- `session`: temporary context for one conversation; expires by default after
  two days.

Inspect lifetime usage counters from the installation directory. This optional
report requires Node.js and npm dependencies:

```bash
cd "${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}"
npm install
npm run memory:usage
```

For a non-Compose database, override the connection:

```bash
MEMORY_USAGE_DATABASE_URL=postgresql://user:password@host:5432/database \
  npm run memory:usage
```

## Data and backups

Memories are stored in the named Docker volume managed by Compose. Stopping
the service preserves data:

```bash
cd "${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}"
docker compose down
```

Removing the volume permanently deletes local memories:

```bash
docker compose down --volumes
```

Backups may contain private memories. Protect them accordingly. Backup and
restore examples are in [`docs/cursor-setup.md`](docs/cursor-setup.md).

## Uninstall

Keep stored memories:

```bash
"${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}/scripts/uninstall.sh" \
  --keep-data
```

Remove the service, Cursor integration, and stored memories:

```bash
"${AGENT_MEMORY_HOME:-$HOME/.local/share/agent-memory}/scripts/uninstall.sh"
```

The destructive path requires typing `DELETE`. Add `--yes` only for automation.

## Development

Clone the repository only if you want to contribute:

```bash
git clone https://github.com/orisilber/agent-memory.git
cd agent-memory
npm install
```

Run checks:

```bash
npm run build
npm run lint
npm run format:check
npm test
RUN_INTEGRATION_TESTS=1 npm test
```

Start the service manually:

```bash
cp .env.example .env
docker compose up -d --build
curl --fail http://127.0.0.1:8787/health
```

More details about Cursor setup, scope rules, loops, and backups:
[`docs/cursor-setup.md`](docs/cursor-setup.md)
