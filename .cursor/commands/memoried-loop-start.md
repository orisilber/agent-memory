# memoried-loop-start

You are the **orchestrator**. You do **not** implement task work yourself. Take an existing memoried-loop task list from **this chat context**, save it into loop checkpoint state, spawn `memoried-loop-worker` per task, review, retry until satisfied, then finish.

Worker: `memoried-loop-worker` (`.cursor/agents/memoried-loop-worker.md` in this repo; installer copies to `~/.cursor/agents/`).

Read and follow skills: `memory-loop`, `memory-recall` (session lessons only), `memory-capture` (session lessons only).

---

## Input (from context)

Find the task list in this conversation — usually from `/memoried-loop-plan`:

1. Prefer the fenced **Machine block** JSON (`planSummary` + `tasks`).
2. Else parse the readable `## Tasks` / `### tN` markdown.
3. Else use a JSON/task list the user pasted with this command.

If none found: stop. Tell user to run `/memoried-loop-plan` first (or paste the task list).

Do **not** re-split a raw feature plan unless the user explicitly asks. Do **not** invent a new backlog when a list already exists in context.

---

## Source of truth (after start)

| Data | Where |
|------|--------|
| Task queue, status, attempts, review notes | `loop_checkpoint.state.tasks` only |
| Cross-task lessons / review fixes | `memory_store` scope **`session`** (optional) |
| Never | task list as memories; never `global` / `repo` memories here |

---

## 1. Start or resume loop

1. `memory_session_start` → keep `sessionId`. Pass on every loop/memory call and every worker prompt (subagents often have a different MCP session).
2. Optional `repoId` from git remote — loop metadata only.
3. `loop_resume` with explicit `sessionId` (+ `runId` if known).
4. If no active run: `loop_start` with explicit `sessionId` and `task` = plan summary.
5. Keep **`runId` + `sessionId`**.

---

## 2. Load tasks into checkpoint

Normalize context tasks into state and `loop_checkpoint` once:

- `idempotencyKey`: `step-0-load-tasks` (reuse on retry)
- `completedSummary`: loaded N tasks from chat plan
- `nextAction`: run first pending task
- `state`:

```json
{
  "planSource": "<from context>",
  "planSummary": "<from context>",
  "tasks": [ /* from context; status pending unless already set */ ],
  "currentTaskId": null
}
```

Statuses: `pending` | `in_progress` | `done` | `blocked`.

If resuming an active run with existing `state.tasks`, prefer checkpoint over re-loading chat unless user says to replace the queue.

Do **not** `memory_store` the task list. Do **not** implement until this checkpoint exists.

Show user a short confirmation: task count + first pending id/title. Then proceed (unless user asked to confirm before start — then wait).

---

## 3. Task loop (one at a time)

While any task is not `done` or `blocked`:

### 3a. Pick next

First `pending` whose `dependsOn` (if any) are all `done`. Set `currentTaskId`. Checkpoint: `step-<n>-claim-<taskId>`.

### 3b. Spawn worker

Spawn **`memoried-loop-worker`** via Task tool (foreground; one at a time).

Prompt must include: `runId`, `sessionId`, optional `repoId`, task `id`/`title`/`detail`, attempt, review feedback from `notes`, worker workflow.

Parent does not implement.

### 3c. Review

Inspect worker report + `git status` / `git diff` + implied verify.

**Accept:** ensure `done` in state; checkpoint `step-<n>-done-<taskId>`; clear `currentTaskId`; next task.

**Reject:** put failure + constraint in task `notes`; bump `attempt`; set `pending`; checkpoint `step-<n>-retry-<taskId>-a<attempt>`. Optional session `memory_store`. Re-spawn. Max **3** attempts unless user overrides → then `blocked`, ask user.

### 3d. Gate

No next task until current accepted. No parallel workers.

---

## 4. Finish

1. Final `loop_checkpoint`.
2. `loop_finish` → `completed` | `failed` | `paused`.
3. Short handoff: done / blocked / risks.

---

## Rules

- Parent = orchestrate + review. Worker = implement.
- Planning = `/memoried-loop-plan` only. This command executes.
- Task board = `loop_checkpoint.state` only.
- Session memories = optional lessons, never the queue.
- No secrets / tokens / raw logs / huge diffs in state or memories.
- One task in flight.
