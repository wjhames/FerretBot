# FerretBot

Local-first, event-driven AI agent system scaffold.

Initial scope:
- Node.js ESM app
- Event bus core
- LM Studio provider integration
- CLI/TUI + Telegram channels
- Deterministic workflow engine, tools, skills, and memory modules

Status:
- Phase 1/1.5/2 core loop and IPC flow implemented.
- Phase 3.5 deterministic workflow modules implemented (`workflows/*`).
- Legacy compatibility adapters remain (`tasks/manager.mjs`, `tools/task.mjs`) for `task:*` step flows.
- Workflow events are emitted and streamed to clients (`workflow:run:*`, `workflow:step:*`, `workflow:needs_approval`).
