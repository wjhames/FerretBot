# Runtime Guide

## Start Order

1. Start the daemon:

```bash
npm run agent
```

2. In a second terminal, start the TUI client:

```bash
npm run tui
```

The agent is headless and can run with zero clients connected.

## LM Studio Setup

1. Start LM Studio.
2. Load the configured model (default: `openai/gpt-oss-20b`).
3. Ensure the OpenAI-compatible endpoint is reachable at the configured base URL.

## Common Issues

- `Connection error` in TUI:
  Agent daemon is not running, or socket/port differs from config.

- Timeout errors:
  Local model generation is slow for the requested output. Lower response size or increase timeout.

- Empty/very short answers:
  The loop now emits a fallback message for empty model output. If frequent, inspect LM Studio model state and prompt/tool context.

## Phase 2 Robustness Notes

- Parse retries:
  On malformed tool JSON, the loop sends a correction prompt and retries up to 2 times before returning `parse_failed`.

- Parse error hints:
  Parser errors include a compact candidate snippet so debugging is easier without blowing up context size.

- Context budgeting:
  Layer budget aliases (`systemPrompt`, `taskScope`, `skillContent`, `priorContext`) are normalized to runtime layer names and fixed layers are scaled to fit the current input budget.

## Phase 3 Task System Wiring

- Built-in `task` tool:
  The tool registry now registers `task` when the lifecycle provides both bus and task manager dependencies.

- Step-scoped tool visibility:
  During `task:step:start`, the loop sends only step-assigned tools plus `task` to the model. This avoids presenting unrelated tool schemas.

- Task state events:
  The bus and IPC routing include `task:step:failed`, `task:step:skipped`, `task:note`, and `task:failed` in addition to existing task events.

- Current boundary:
  Planner output is validated and the manager can run plans, but automatic conversion of every `user:input` into planned tasks is not enabled by default. Task execution requires creating a task plan through explicit orchestration.
