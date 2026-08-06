# Cursor setup

## Install

After cloning repository:

```bash
./scripts/install.sh
```

Installer creates `.env`, builds/starts Docker, installs skills under
`~/.cursor/skills/`, installs rule under `~/.cursor/rules/`, and merges local
MCP server into `~/.cursor/mcp.json`.
Use `./scripts/install.sh --skip-mcp` to leave Cursor configuration unchanged.

To remove service, skills, rule, MCP entry, `.env`, and stored memories:

```bash
./scripts/uninstall.sh
```

Installer asks for `DELETE` confirmation. Use `./scripts/uninstall.sh --yes`
for automation, or `./scripts/uninstall.sh --keep-data` to preserve memories.
Add `--keep-config` to preserve local `.env`.

## Start service manually

From project root:

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

API binds to localhost. PostgreSQL binds to localhost port `5433` for local
tests and backup commands.

For stronger local protection, set `MEMORY_API_KEY` in `.env`. Keep same value
available to Cursor through its environment. Do not commit `.env`.

## Register MCP server

Add server entry to project `.cursor/mcp.json` or user `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-memory": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

If `MEMORY_API_KEY` is set, add header using environment interpolation:

```json
{
  "mcpServers": {
    "agent-memory": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MEMORY_API_KEY}"
      }
    }
  }
}
```

Restart or reload Cursor MCP servers after changing this file.

## Install skills globally

Skills are versioned in this repository. Copy them to user skill storage so
they surface in every repository:

```bash
mkdir -p ~/.cursor/skills
cp -R .cursor/skills/memory-* ~/.cursor/skills/
```

Project-only use: leave skills under `.cursor/skills/` and open this repository
in Cursor.

Memoried-loop slash commands and worker stay **project-only** in this repo:

- `.cursor/commands/memoried-loop-plan.md`
- `.cursor/commands/memoried-loop-start.md`
- `.cursor/agents/memoried-loop-worker.md`

This repository includes always-on policy
`.cursor/rules/agent-memory.mdc`; installer copies it to
`~/.cursor/rules/agent-memory.mdc` so it applies from other repositories too.

## Scope rules

- `global`: personal preference or reusable procedure. No context required.
- `repo`: project convention or decision. Pass canonical git remote as `repoId`;
  use normalized repository root when no remote exists.
- `session`: current conversation or temporary work. `sessionId` optional when
  tools run over an active MCP session; server falls back to the MCP transport
  session ID. Call `memory_session_start` only when you need an explicit ID
  outside that MCP session. Session memories expire after 2 days by default;
  set `SESSION_RETENTION_DAYS` to change the retention period.

Search only scopes needed for task. Multi-scope search must list every scope
explicitly. Never assume global memory overrides current user instructions.

## Loop rules

1. Omit `sessionId` when MCP session is active, or call `memory_session_start`
   for an explicit ID.
2. Call `loop_start` with task and repository context.
3. Call `loop_resume` after reconnect or interruption.
4. Save short `loop_checkpoint` after meaningful work and before retryable side
   effects.
5. Use stable idempotency keys.
6. Verify current state before repeating side effects.
7. Call `loop_finish`.

Checkpoint summaries must contain state, completed work, errors, artifacts, and
next action. Loop runs and checkpoints expire after the same retention period;
checkpoint activity refreshes it. Never store credentials or raw command logs.

## Backup and restore

Default credentials:

```bash
docker compose exec db pg_dump -U memory -d agent_memory > backup.sql
cat backup.sql | docker compose exec -T db psql -U memory -d agent_memory
```

If `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB` changed, use those
values instead. Backups may contain private memories; protect them.

## Stop service

```bash
docker compose down
```

Keep volume data with `docker compose down`. Removing the volume permanently
deletes local memories.
