# memoried-loop-plan

Split a plan into **small, user-readable tasks**. Do **not** start a loop, checkpoint, store memories, edit project files, or spawn workers.

Input: plan (paste, path, or attached). If missing, ask.

---

## What to do

1. Read the plan (and skim repo only if needed to name real files/areas).
2. Break into **small, single-outcome tasks** in dependency order.
3. Print the task list in chat for the user to review/edit.
4. Stop. Tell user to run `/memoried-loop-start` when ready (optionally after editing the list in chat).

---

## Output format (exact)

Use this structure so humans can read it and `/memoried-loop-start` can take it from context:

```markdown
# Memoried loop plan

**Summary:** <1-3 sentences>
**Source:** <path or inline>

## Tasks

### t1 — <short title>
- **Done looks like:** <acceptance in plain language>
- **Touches:** <files/areas if known, else "TBD">
- **Depends on:** <none | task ids>

### t2 — <short title>
- **Done looks like:** ...
- **Touches:** ...
- **Depends on:** t1

## Machine block

\`\`\`json
{
  "planSource": "<path or inline>",
  "planSummary": "<1-3 sentences>",
  "tasks": [
    {
      "id": "t1",
      "title": "<short title>",
      "detail": "<done looks like + touches>",
      "dependsOn": [],
      "status": "pending",
      "attempt": 0,
      "notes": ""
    }
  ]
}
\`\`\`
```

Rules for the list:

- One coherent change per task.
- Ids: `t1`, `t2`, … in run order (respect `dependsOn`).
- No implementation. No `/memoried-loop-start` behavior.
- No `loop_*`, no `memory_store` / `memory_search`.

---

## Handoff

End with: edit the tasks in chat if needed, then run `/memoried-loop-start` (same thread so the list stays in context).
