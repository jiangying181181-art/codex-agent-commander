---
name: codex-agent-commander
description: Use when Codex should act as commander and may delegate bounded assistant work without the user explicitly naming a tool. Trigger for code review, audits, testing, UI checks, independent verification, long-running validation, multi-round follow-up, or when Codex needs Claude Code or another local assistant as a helper while Codex keeps final responsibility.
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

## Local Bridge

Use the bridge script from this repository:

```powershell
node .\scripts\agent-commander.mjs run-hidden --project-root "<current project folder>" --title "<short task title>" --body "<task instructions>"
```

For follow-up rounds in the same visible Claude Code window:

```powershell
node .\scripts\agent-commander.mjs continue-visible --run <run_id> --body "<follow-up instructions>"
```

The bridge stores project-local task files and reports under:

```text
<project root>\.agent-commander\
```

## Project Root Rule

Use the Codex conversation's current working project folder as `project-root`. Do not use the bridge install folder unless the user is actually working on the bridge project. If uncertain, inspect the current working directory and choose the nearest actual project folder.

## Claude Code Defaults

On Windows, run Claude Code in the background by default. Default to bypass permissions mode for delegated assistant work unless the user or environment requires a safer mode.

Do not use techniques that disturb the user's current desktop session. Do not overwrite the clipboard. Do not inject keystrokes into the user's active app. Do not open multiple visible assistant windows. Use the project lock and run assistant work sequentially.

## Report Status

Ask the assistant to write a Markdown report with:

```markdown
- status: done | needs_followup | blocked | failed
```

Interpret it as:

- `done`: verify evidence, close the window, and finish or summarize.
- `needs_followup`: send another bounded round under the same run, sequentially under the project lock.
- `blocked`: decide whether Codex can unblock or needs user input.
- `failed`: inspect failure and either fix directly or retry with narrower instructions.
