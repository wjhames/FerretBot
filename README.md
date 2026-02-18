# FerretBot

Small fast and gets into everything.

FerretBot is a local-first agent runtime. It runs on your machine, talks to a local LLM through LM Studio, and drives deterministic workflows over an event bus.

## What It Is Right Now

- Node.js ESM daemon + terminal CLI client
- Event-driven core (bus, lifecycle, IPC)
- Agent loop with tool-call cycle and parser retries
- Token-budgeted context assembly from workspace prompt layers
- Workflow engine for YAML DAGs with retries/checks
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

1. CLI sends `user:input` over IPC.
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
npm run cli -- message "Hello"
```

Workflow commands:

```bash
npm run cli -- workflow run <workflow-id> [--version <semver>] [--arg key=value]
npm run cli -- workflow cancel <run-id>
npm run cli -- workflow list
```

## Default Paths

- Config: `~/.ferretbot/config.json`
- IPC socket: `~/.ferretbot/agent.sock`
- Sessions: `~/.ferretbot/sessions`
- Workflow runs: `~/.ferretbot/workflow-runs`
- Workspace: current working directory (`process.cwd()`) unless `workspace.path` is set

## Workflow + Skills Notes

- Workflows default to `./.ferretbot/workflows/<workflow-id>/workflow.yaml`.
- Override workflow root with `workflows.rootDir` in `~/.ferretbot/config.json`.
- Engine supports `agent` and system file steps.
- `loadSkills` resolution order: step, then workflow, then global.
- `.ferretbot/` is gitignored in this repo, so workflow YAML files are local-only by default.
- To share workflow definitions in git, set `workflows.rootDir` to a tracked path (for example `./workflows`).

## Current Status

- CLI is the only shipped client (TUI removed).
- Message command prints assistant text only.
- Workflow runs/steps persist under `.ferretbot/workflow-runs`.
- Current workflow model is non-interactive: no approval/input pause steps.

## Troubleshooting

- `Connection error` in CLI:
  Agent daemon is not running, or socket/port differs from CLI flags/config.
- Timeout/slow responses:
  Local model generation is slow for requested output. Reduce response size or increase provider timeout.
- Empty/very short answers:
  The loop emits a fallback message for empty model output. If frequent, inspect LM Studio model state and prompt/tool context.

## Runtime Notes

- Parse retries:
  On malformed tool JSON, the loop sends a correction prompt and retries up to 2 times before returning `parse_failed`.
- Parse error hints:
  Parser errors include a compact candidate snippet for debugging without excessive context growth.
- Context budgeting:
  Layer budget aliases (`systemPrompt`, `taskScope`, `skillContent`, `priorContext`) are normalized to runtime layer names.

## Commands

```bash
npm test
```
