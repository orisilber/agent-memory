# Agent Memory

Local, scoped memory service for Cursor agents.

## Stack

- PostgreSQL 18 with `pgvector`, `pg_trgm`, and full-text search
- TypeScript MCP server over Streamable HTTP
- Docker Compose with persistent database volume
- Global, repository, and session scopes
- Durable loop runs and checkpoints

## Run

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Service endpoint: `http://127.0.0.1:8787/mcp`.

## Install on another computer

After cloning repository:

```bash
./scripts/install.sh
```

Installer creates `.env`, starts Docker, installs global Cursor skills, and
merges `agent-memory` into `~/.cursor/mcp.json`. Use `--skip-mcp` to leave
Cursor configuration unchanged.

Remove installation and stored memories:

```bash
./scripts/uninstall.sh
```

Use `--keep-data` to stop services while preserving memories. Uninstall asks
for `DELETE` confirmation before removing data.

Cursor setup, skill installation, scope rules, and backups:
[`docs/cursor-setup.md`](docs/cursor-setup.md)

## Development

```bash
npm install
npm run build
npm test
RUN_INTEGRATION_TESTS=1 npm test
```

Integration tests use local PostgreSQL at port `5433` by default.

## MCP tools

- `memory_session_start`
- `memory_search`
- `memory_store`
- `memory_update`
- `memory_archive`
- `memory_forget`
- `memory_list`
- `loop_start`
- `loop_checkpoint`
- `loop_resume`
- `loop_finish`
