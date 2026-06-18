# Codex Agent Commander

Codex Agent Commander is a Codex skill and local bridge for using assistant agents such as Claude Code while Codex stays in charge.

Codex remains the commander. Claude Code and other agents are helpers for bounded audits, tests, verification, and follow-up checks.

## What It Does

- Runs Claude Code in the background by default.
- Uses the current project folder, not a hard-coded machine path.
- Writes task instructions and reports under the project-local `.agent-commander` folder.
- Uses `bypassPermissions` by default for delegated Claude Code work.
- Supports follow-up rounds.
- Uses a project lock so only one assistant task runs at a time.
- Does not use or overwrite the user's system clipboard.
- Does not inject keystrokes into the user's active desktop session.
- Does not open multiple assistant windows or disturb the user's current app focus, typing, and clipboard.

## Requirements

- Windows
- Node.js 18 or newer
- Claude Code installed and available as `claude.cmd` or `claude`

## Quick Check

From this repository:

```powershell
node .\scripts\agent-commander.mjs doctor --project-root "C:\path\to\your\project"
```

## Run A Background Assistant Task

```powershell
node .\scripts\agent-commander.mjs run-hidden --project-root "C:\path\to\your\project" --title "Audit current change" --body "Review the current change and write a report only."
```

## Continue The Same Run

```powershell
node .\scripts\agent-commander.mjs continue-visible --run <run_id> --body "Follow up on the previous report and verify the missing item."
```

Follow-up rounds run sequentially under the same project lock. This is deliberate: the public version avoids controlling the user's active keyboard, mouse, windows, or clipboard.

## Install As A Codex Skill

Copy the `skill/codex-agent-commander` folder into your Codex skills folder, or copy this repository's `skill/SKILL.md` into a folder named `codex-agent-commander`.

The skill is designed so users do not need to say "use Claude Code". Codex should decide when to delegate based on the task.
