# FerretBot

Small fast and gets into everything.

FerretBot is a local-first agent runtime. It runs on your machine, talks to a local LLM through LM Studio, and drives deterministic workflows over an event bus.

## What It Is Right Now

- Node.js ESM daemon + terminal CLI client
- Event-driven core (bus, lifecycle, IPC)
- Agent loop with tool-call cycle and parser retries
- Guardrails for empty final responses and unsafe tool usage
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
- `tools/`: registry + built-ins (`bash`, `read`, `write`)
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
npm run cli -- workflow lint [<workflow-id>] [--version <semver>]
npm run cli -- workflow dry-run <workflow-id> [--version <semver>] [--arg key=value]
```

## Repo Setup

Before first real use, copy/rename the example file to canonical name and customize:

- `.ferretbot/AGENTS.example.md` -> `.ferretbot/AGENTS.md`

Only `*.example.md` files are tracked for sharing.
Runtime data is still local-only and gitignored:

- `.ferretbot/sessions/`
- `.ferretbot/workflow-runs/`

## Default Paths

- Config: `<cwd>/.ferretbot/config.json`
- IPC socket: `<cwd>/.ferretbot/agent.sock`
- Sessions: `<cwd>/.ferretbot/sessions`
- Workflow runs: `<cwd>/.ferretbot/workflow-runs`
- Workspace root: `<cwd>/.ferretbot` unless `workspace.path` is set

## Workflow + Skills Notes

- Workflows default to `./.ferretbot/workflows/<workflow-id>/workflow.yaml`.
- Override workflow root with `workflows.rootDir` in `<cwd>/.ferretbot/config.json`.
- Engine supports `agent` and system file steps.
- `loadSkills` resolution order: step, then workflow, then global.
- This repo currently ships no bundled workflows under `.ferretbot/workflows/`.
- Workflow step contracts currently support: `id`, `name`, `type`, `instruction`, `tools`, `loadSkills`, `dependsOn`, `outputs`, `doneWhen`, `onFail`, `retries`, `path`, `content`, `mode`.
- Workflow step context is step-focused by default: current step, allowed tools, workflow args, prior step results, and requested skills.
- Built-in success checks include `contains`, `not_contains`, `regex`, `exit_code`, `command_exit_code`, `file_exists`, `file_not_exists`, `file_contains`, `file_regex`, `file_hash_changed`, `non_empty`.
- Contract-first default: each step should declare `outputs` and file-backed `doneWhen` checks.
- Agent step completion emits structured payload fields: `resultText`, `toolCalls`, `toolResults`, `artifacts`.
- Runs can end in `blocked` when `onFail: blocked` is set or when no-progress is detected on repeated failed attempts.

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
  The loop retries final generation and then returns a structured guardrail failure if output stays empty. If frequent, inspect LM Studio model state and prompt/tool context.

## Runtime Notes

- Parse retries:
  On malformed tool JSON, the loop sends a correction prompt and retries up to 2 times before returning `parse_failed`.
- Parse error hints:
  Parser errors include a compact candidate snippet for debugging without excessive context growth.
- Write safety:
  Overwriting existing code files requires explicit `rewriteReason`.
- Command hygiene:
  Recursive directory dumps like `ls -R` are rejected and retried with correction guidance.
- Context budgeting:
  Layer budget aliases (`systemPrompt`, `taskScope`, `skillContent`, `priorContext`) are normalized to runtime layer names.

## Commands

```bash
npm test
```
