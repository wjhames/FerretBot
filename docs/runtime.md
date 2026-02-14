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
