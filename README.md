# FerretBot

Local-first, event-driven AI agent system scaffold.

Initial scope:
- Node.js ESM app
- Event bus core
- LM Studio provider integration
- CLI/TUI + Telegram channels
- Task planner/manager, tools, skills, and memory modules

Status:
- Phase 1/1.5/2 core loop and IPC flow implemented.
- Phase 3 modules implemented (`tasks/planner.mjs`, `tasks/manager.mjs`, `tools/task.mjs`).
- Task tool is registered at runtime and exposed during `task:step:start` execution.
- Planner orchestration from arbitrary `user:input` into a task plan is not auto-enabled yet.
