# FerretBot

Small fast and gets into everything.

FerretBot is a local-first agent runtime. It runs on your machine, talks to a local LLM through LM Studio, and drives deterministic workflows over an event bus.

## What It Is Right Now

- Node.js ESM daemon + terminal TUI client
- Event-driven core (bus, lifecycle, IPC)
- Agent loop with tool-call cycle and parser retries
- Token-budgeted context assembly from workspace prompt layers
- Workflow engine for YAML DAGs with retries/checks/approval gates
- Built-in tools: `bash`, `read`, `write`
- Skills loaded at global, workflow, and step levels
- Session memory (JSONL) + durable workspace memory

## Runtime Shape

Main subsystems in play:

- `core/`: event bus, lifecycle wiring, IPC server, config defaults
- `agent/`: context builder, prompt/bootstrap manager, parser, loop
- `workflows/`: loader, schema checks, registry, run engine
- `tools/`: registry + built-ins
- `provider/`: LM Studio adapter behind a provider interface
- `memory/`: per-session transcripts + workspace file manager

Data path, simplified:

1. TUI sends `user:input` over IPC.
2. IPC emits on the event bus.
3. Agent loop builds context, calls provider, parses output.
4. Tool calls (if any) execute through tool registry, then loop continues.
5. Final response is persisted and emitted back to client.

## Requirements

- Node.js `>= 20`
- LM Studio running with an OpenAI-compatible endpoint

## Quick Start

```bash
npm install
npm run agent
```

In another terminal:

```bash
npm run tui
```

## Default Paths

- Config: `~/.ferretbot/config.json`
- IPC socket: `~/.ferretbot/agent.sock`
- Sessions: `~/.ferretbot/sessions`
- Workflow runs: `~/.ferretbot/workflow-runs`
- Workspace: `~/.ferretbot/workspace`

## Workflow + Skills Notes

- Workflows live under `workflows/<workflow-id>/workflow.yaml`.
- Engine supports `agent`, `wait_for_input`, and system file steps.
- `loadSkills` resolution order: step, then workflow, then global.

## Commands

```bash
npm test
```

More architecture details:

- `architecture/README.md`
