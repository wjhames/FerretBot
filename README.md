# FerretBot

Small, fast, and gets into everything.

## Current Scope

Local-first, event-driven runtime focused on deterministic workflows.

- Node.js ESM runtime
- LM Studio provider (`/chat/completions`)
- IPC daemon + terminal TUI client (NDJSON over Unix socket/TCP)
- Deterministic workflow registry/engine (`workflow.yaml`)
- Tool runtime (`bash`, `read`, `write`)
- Skill loader (global/workflow/step skill files)
- Session/workspace memory modules

## Requirements

- Node.js `>= 20`
- LM Studio running with OpenAI-compatible endpoint

## Install

```bash
npm install
```

## Quick Start

1. Start the agent daemon:

```bash
npm run agent
```

2. In another terminal, start the TUI client:

```bash
npm run tui
```

3. Chat in the TUI. The client sends `user:input` events over IPC.

## Default Runtime Paths

- Config: `~/.ferretbot/config.json`
- IPC socket: `~/.ferretbot/agent.sock`
- Workflow run records: `~/.ferretbot/workflow-runs`

## Config Example

Create `~/.ferretbot/config.json`:

```json
{
  "provider": {
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "openai/gpt-oss-20b",
    "timeoutMs": 300000,
    "temperature": 0,
    "topP": 1
  },
  "ipc": {
    "socketPath": "/home/YOUR_USER/.ferretbot/agent.sock"
  },
  "agent": {
    "maxTokens": 1024,
    "maxToolCallsPerStep": 10
  },
  "tools": {
    "cwd": "/home/YOUR_USER/projects/FerretBot",
    "rootDir": "/home/YOUR_USER/projects/FerretBot",
    "rootDirs": [
      "/home/YOUR_USER/projects/FerretBot",
      "/home/YOUR_USER/.ferretbot/workspace"
    ],
    "maxReadBytes": 131072
  },
  "workflows": {
    "rootDir": "/home/YOUR_USER/projects/FerretBot/workflows",
    "runsDir": "/home/YOUR_USER/.ferretbot/workflow-runs"
  },
  "skills": {
    "rootDir": "/home/YOUR_USER/projects/FerretBot",
    "dirName": "skills"
  },
  "memory": {
    "sessionsDir": "/home/YOUR_USER/.ferretbot/sessions"
  },
  "workspace": {
    "path": "/home/YOUR_USER/.ferretbot/workspace",
    "cleanupThresholdMs": 604800000
  }
}
```

Notes:
- If `ipc.port` is set, IPC uses TCP (`host` + `port`) instead of Unix socket.
- Defaults exist for most fields, but explicit paths are safer for local setups.
- `tools.rootDirs` is optional. If set, `read`/`write` can access all listed roots.

## Workflow Layout

Each workflow lives under `workflows/<workflow-id>/workflow.yaml`.

Minimal example:

```yaml
id: demo-workflow
version: "1.0.0"
name: Demo Workflow
description: Simple one-step workflow
steps:
  - id: summarize
    instruction: Summarize the request in one paragraph.
    tools: ["read", "write"]
    dependsOn: []
    loadSkills: []
    retries: 0
    approval: false
```

Validation rules include:
- workflow `id` matches `^[a-z0-9-]+$`
- `steps` non-empty
- each step has `id`, `instruction`, non-empty `tools`
- dependency references must exist; cycles rejected

## Skills Layout

- Global skills: `<root>/<skillsDir>/<skill-name>/SKILL.md`
- Workflow skills: `<workflow-dir>/SKILL.md` or `*.skill.md`
- Step skills: `<workflow-dir>/steps/*.skill.md`

When `loadSkills` is set on a workflow step, precedence is:
1. step skill
2. workflow skill
3. global skill

## Core Events

Outbound IPC events include:
- `agent:response`
- `agent:status`
- `workflow:run:queued`
- `workflow:step:start`
- `workflow:step:complete`
- `workflow:needs_approval`
- `workflow:run:complete`

## Test

```bash
npm test
```

## Docs

- Runtime notes: `docs/runtime.md`
