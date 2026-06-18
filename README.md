# Codex Agent Commander

Codex Agent Commander is a Codex skill and local bridge for using assistant agents such as Claude Code while Codex stays in charge.

Codex remains the commander. Claude Code and other agents are helpers for bounded audits, tests, verification, and follow-up checks.

Assistant routing is project-neutral. Named projects should be handled through project-local configuration, not hard-coded into the bridge.

## What It Does

- Runs Claude Code in the background by default.
- Runs WorkBuddy through its bundled `codebuddy` CLI when selected.
- Uses the current project folder, not a hard-coded machine path.
- Supports project-local configuration through `.agent-commander/config.json`.
- Writes task instructions and reports to project-specific folders.
- Uses `bypassPermissions` by default for delegated Claude Code work.
- Supports follow-up rounds.
- Uses a project lock so only one assistant task runs at a time.
- If Claude Code is missing, reports `assistant_unavailable` and lets Codex continue the task directly.
- Does not use or overwrite the user's system clipboard.
- Does not inject keystrokes into the user's active desktop session.
- Does not open multiple assistant windows or disturb the user's current app focus, typing, or clipboard.

## Assistant Routing

- Codex: primary implementation, architecture decisions, product judgment, and final delivery.
- Claude Code: code review, architecture or logic audits, regression risk checks, and second-opinion analysis.
- WorkBuddy: runtime checks, environment checks, UI or workflow verification, dry-run validation, local acceptance checks, and evidence collection.
- Claude Code plus WorkBuddy: use both when a task needs independent code-risk review and runtime acceptance evidence.

The same routing applies to any project. Project-specific instructions belong in `.agent-commander/config.json`.

## Requirements

- Node.js 18 or newer
- Claude Code installed and available as `claude.cmd` or `claude`

## Quick Check

From this repository:

```powershell
node .\scripts\agent-commander.mjs doctor --project-root "C:\path\to\your\project"
```

## Run A Background Assistant Task

```powershell
node .\scripts\agent-commander.mjs run-hidden --assistant claude --project-root "C:\path\to\your\project" --title "Audit current change" --body "Review the current change and write a report only."
```

To use WorkBuddy:

```powershell
node .\scripts\agent-commander.mjs run-hidden --assistant workbuddy --project-root "C:\path\to\your\project" --title "Runtime check" --body "Check the project and write a report only."
```

## Continue The Same Run

```powershell
node .\scripts\agent-commander.mjs continue-hidden --assistant claude --project-root "C:\path\to\your\project" --run <run_id> --body "Follow up on the previous report and verify the missing item."
```

Follow-up rounds run sequentially under the same project lock. This is deliberate: the public version avoids controlling the user's active keyboard, mouse, windows, or clipboard.

## Project Configuration

Create this optional file in any project:

```text
<project root>\.agent-commander\config.json
```

Example:

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

Relative paths are resolved from the project root. This keeps the bridge reusable across projects and computers.

## Install As A Codex Skill

Copy the `skill/codex-agent-commander` folder into your Codex skills folder.

The skill is designed so users do not need to say "use Claude Code". Codex should decide when to delegate based on the task.
