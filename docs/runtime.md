# Runtime Guide

## Start Order

1. Start the daemon:

```bash
npm run agent
```

2. In a second terminal, send a CLI message:

```bash
npm run cli -- message "Hello"
```

The agent is headless and can run with zero clients connected.

## LM Studio Setup

1. Start LM Studio.
2. Load the configured model (default: `openai/gpt-oss-20b`).
3. Ensure the OpenAI-compatible endpoint is reachable at the configured base URL.

## Common Issues

- `Connection error` in CLI:
  Agent daemon is not running, or socket/port differs from CLI flags/config.

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

## Workflow Runtime Wiring

- Workflow engine:
  The lifecycle loads workflow definitions, starts the workflow registry/engine, and emits deterministic workflow step events.

- Workflow step execution:
  During `workflow:step:start`, the loop sends only step-assigned tools to the model and auto-emits `workflow:step:complete` on final text responses.

- Event routing:
  IPC forwards workflow events so connected clients can observe run lifecycle and step progression.

## Workflow File Location

- Default root: `./.ferretbot/workflows`
- Each workflow: `<workflow-id>/workflow.yaml`
- Override root with `workflows.rootDir` in `~/.ferretbot/config.json`
