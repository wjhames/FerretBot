# FerretBot

Project status: Unstable.

This repo is an experimental local-first agent runtime.
Current implementation exists, tests pass, but real task reliability is still poor.

## Reality Check

- `read` tool: inconsistent in real loops
- `write` tool: inconsistent in real loops
- `bash` tool: inconsistent in real loops
- workflow + agent behavior: not dependable enough for production use

If your expectation is "works every time", this project does not meet it today.

## What Exists

- Node.js ESM runtime
- IPC + event bus core
- agent loop + parser + context management
- workflow engine (YAML DAG model)
- built-in tools: `read`, `write`, `bash`
- test suite (`npm test`)

## Local Commands

```bash
npm install
npm run agent
npm run cli -- message "hello"
npm test
```
