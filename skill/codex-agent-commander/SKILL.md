---
name: codex-agent-commander
description: Use when Codex should act as commander and may delegate bounded assistant work without the user explicitly naming Claude Code or another tool. Trigger for code review, audits, testing, UI checks, independent verification, long-running validation, multi-round follow-up, or when Codex needs a local assistant as a helper while Codex keeps final responsibility.
---

# Codex Agent Commander

Codex is the commander and primary developer. External agents are assistants. Use them only to offload bounded work such as audits, tests, verification, UI checks, or second-opinion reports. Do not treat external agents as the lead.

The user does not need to say "use Claude Code". Decide whether delegation is useful from the task itself.

## Default Policy

1. Codex understands the goal and decides the plan.
2. Codex does the work directly when that is simpler or safer.
3. Codex delegates only bounded helper work.
4. Codex writes clear instructions and required report paths.
5. Codex reads the report and judges whether it is enough.
6. Codex continues, reassigns, or finishes. Codex remains responsible for the final answer.

## Universal Assistant Routing

Do not make assistant routing project-specific. Any named project is only a project configuration example.

Choose assistants by task type:

- Use Codex directly for primary implementation, architecture decisions, product judgment, and final delivery.
- Use Claude Code for code review, architectural risk review, logic audits, regression risk checks, and second-opinion analysis.
- Use WorkBuddy for runtime checks, environment checks, UI or workflow verification, dry-run validation, local acceptance checks, and evidence collection.
- Use both when a task needs independent code-risk review plus runtime or UI acceptance. Read both reports and make the final decision in Codex.
- If an assistant is unavailable or not a good fit, continue in Codex without blocking the user's task.

Respect project-local configuration for context files and report folders. Do not hard-code a project name, product name, path, or domain into the generic routing policy.

## Bridge Script

Use the bundled script in this skill folder:

```powershell
node "<this skill folder>\scripts\agent-commander.mjs" run-hidden --assistant claude --project-root "<current project folder>" --title "<short task title>" --body "<task instructions>"
```

`run-hidden` launches a hidden background worker and returns quickly with `runId`, `workerPid`, instruction path, and report path. Use `check --run <run_id>` to inspect status and read the report. Add `--wait` only when a deliberately blocking run is required.

For follow-up rounds under the same run:

```powershell
node "<this skill folder>\scripts\agent-commander.mjs" continue-hidden --assistant claude --project-root "<current project folder>" --run <run_id> --body "<follow-up instructions>"
```

Use `--assistant workbuddy` when delegating to WorkBuddy. Prefer the WorkBuddy bundled `codebuddy` CLI in background mode; do not control the WorkBuddy desktop UI unless the user explicitly asks for visible desktop automation.

Use the Codex conversation's current working project folder as `project-root`. Do not use the skill install folder unless the user is actually working on this bridge project.

## Project Configuration

If `<project root>\.agent-commander\config.json` exists, the bridge will use it automatically. This allows each project to choose its own task folder, report folder, and context files without hard-coding machine-specific paths in the skill.

Supported config fields:

```json
{
  "stateRoot": ".agent-commander",
  "taskDir": ".agent-commander/tasks",
  "reportDir": ".agent-commander/reports",
  "contextFiles": [],
  "assistantContextFiles": {
    "claude": [],
    "workbuddy": []
  }
}
```

Relative paths are resolved from the project root.

## Claude Code Defaults

Run Claude Code in the background by default. The bridge should return immediately after the worker starts; then poll with `check`. Always default delegated assistant work to `bypassPermissions` unless the user explicitly asks for a different mode in the current task.

Do not disturb the user's desktop session. Do not overwrite the clipboard. Do not inject keystrokes into the user's active app. Do not open multiple assistant windows. Use the project lock and run assistant work sequentially.

If Claude Code or WorkBuddy is missing, the bridge returns `assistant_unavailable` with `codexAction: continue_without_assistant`. Treat this as a delegation skip, not as a failure of the user's task. Continue the work directly in Codex and mention that assistant collaboration was unavailable only when it matters to the user.

The bridge archives stale lock files automatically when the recorded process is gone. If an assistant hangs or times out, inspect the run folder's stdout/stderr files and continue in Codex unless a retry is clearly useful.

## WorkBuddy Defaults

Use WorkBuddy through its `codebuddy` CLI with `-p`, `-y`, `--permission-mode bypassPermissions`, and `--add-dir <project root>`. WorkBuddy is a desktop app, but the bridge should not click, type, or paste into the visible desktop window by default.

WorkBuddy runs default to `--max-turns 8` so the assistant has enough budget to read context and write the required report. If stdout says `Max turns exceeded`, treat it as an invocation budget problem and retry with a larger `--max-turns` value before treating it as a project finding.

## Diagnostics

Use `dry-run` to generate task files and report paths without launching an assistant. Use `doctor --doctor-run` only when a real assistant write-report check is needed. Use `check --run <run_id>` after background launch. Read `<reportDir>\index.json` for the run history when available.

## Report Status

Ask the assistant to write a Markdown report with:

```markdown
- status: done | needs_followup | blocked | failed
```

Interpret it as:

- `done`: verify evidence and finish or summarize.
- `needs_followup`: send another bounded round under the same run, sequentially under the project lock.
- `blocked`: decide whether Codex can unblock or needs user input.
- `failed`: inspect failure and either fix directly or retry with narrower instructions.
