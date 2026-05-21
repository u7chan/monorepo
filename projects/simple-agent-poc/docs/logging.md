# Debug Logging

## Overview

`simple-agent-poc` writes structured JSONL debug logs for every agent execution.  
Logs are intended for local debugging and coding-agent handoff — not for production-grade audit trails.

## Where Logs Are Written

Default output file: `logs/agent-debug.jsonl`

The `logs/` directory is already listed in `.gitignore`.

## Configuration

| Environment Variable | Default | Description |
|:---|:---|:---|
| `SIMPLE_AGENT_LOG_ENABLED` | `true` | Set to `false` to disable all debug logging. |
| `SIMPLE_AGENT_LOG_FILE` | `logs/agent-debug.jsonl` | Path to the JSONL output file. |
| `SIMPLE_AGENT_LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`. |
| `SIMPLE_AGENT_LOG_PAYLOADS` | `summary` | Payload policy: `summary`, `metadata`, or `full`. |
| `SIMPLE_AGENT_LOG_MAX_FIELD_CHARS` | `500` | Maximum characters in `preview` under the `summary` policy. |

Example `.env` entries:

```bash
SIMPLE_AGENT_LOG_ENABLED=true
SIMPLE_AGENT_LOG_PAYLOADS=summary
SIMPLE_AGENT_LOG_MAX_FIELD_CHARS=500
```

## JSONL Event Shape

Each log line is a JSON object:

```json
{
  "timestamp": "2026-05-19T00:00:00.000000Z",
  "level": "INFO",
  "event": "agent.run.start",
  "logger": "simple_agent_poc.observability",
  "run_id": "hex-string",
  "session_id": "session-id-or-null",
  "agent_id": "default",
  "mode": "cli",
  "round": 0,
  "model": "gpt-4.1-mini",
  "api_type": "completion",
  "stream": true,
  "tool_call_id": null,
  "tool_name": null,
  "elapsed_ms": 1234,
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 20,
    "total_tokens": 70
  },
  "message_count": 4,
  "payload": {
    "preview": "short text",
    "length": 100,
    "sha256": "hash"
  },
  "error": null
}
```

## How to Correlate Logs

Search the JSONL file by:

| Key | Purpose |
|:---|:---|
| `session_id` | Track all turns within one conversation. |
| `run_id` | Track one invocation of `execute_stream()` or `continue_stream()`. |
| `agent_id` | Filter runs for a specific agent definition. |
| `round` | Identify which ReAct round an event occurred in. |
| `tool_call_id` | Trace a specific tool call through start/end/result. |

Example using `jq`:

```bash
# Find all events for a specific session
jq 'select(.session_id == "abc123")' logs/agent-debug.jsonl

# Find all tool calls
jq 'select(.event | startswith("tool.call."))' logs/agent-debug.jsonl

# Find all errors
jq 'select(.event | endswith(".error"))' logs/agent-debug.jsonl
```

## Payload Policies

Control how request/response/tool payloads are stored:

### `summary` (default)

Stores `preview` (first N chars), `length`, `sha256`, and type information.  
Safe for sharing with coding agents.

### `metadata`

Stores `length`, `sha256`, and type only — no content preview.  
Use when the log file will be committed or shared outside the machine.

### `full`

Stores the complete content.  
Use only for local debugging when full prompt/response inspection is needed.

## What Should Be Shared with a Coding Agent

When debugging agent behaviour with a coding agent:

1. Set `SIMPLE_AGENT_LOG_PAYLOADS=summary` (default).
2. Copy the relevant JSONL lines filtered by `session_id` or `run_id`.
3. Share only the log lines — no source code, `.env`, or API keys.

The `summary` policy excludes full prompt/response bodies while providing enough
context (event names, token usage, tool call names, error messages) to diagnose
most issues.

## Event Reference

### Agent Lifecycle

| Event | Description |
|:---|:---|
| `agent.run.start` | A new execution run begins. |
| `agent.run.end` | A run completes successfully. |
| `agent.run.error` | A run fails with an exception. |

### Session

| Event | Description |
|:---|:---|
| `session.created` | A new conversation session is created. |
| `session.loaded` | An existing session is loaded. |
| `session.saved` | A session snapshot is persisted. |
| `session.not_found` | Requested session does not exist. |

### ReAct Round

| Event | Description |
|:---|:---|
| `react.round.start` | A new ReAct round begins. |
| `react.round.end` | A ReAct round completes. |
| `react.max_rounds_exceeded` | Maximum tool-call rounds hit. |

### LLM

| Event | Description |
|:---|:---|
| `llm.stream.start` | A streaming LLM request begins. |
| `llm.stream.end` | A streaming LLM request completes. |
| `llm.stream.error` | A streaming LLM request fails. |

### Tool Calls

| Event | Description |
|:---|:---|
| `tool.call.start` | Tool execution begins. |
| `tool.call.end` | Tool execution completes. |
| `tool.call.error` | Tool execution fails. |

### ask_user / Pause-Resume

| Event | Description |
|:---|:---|
| `ask_user.pause` | Session paused waiting for user input. |
| `ask_user.resume` | A paused session is being resumed. |
| `ask_user.answered` | User answers have been applied. |

### Adapter Errors

| Event | Description |
|:---|:---|
| `cli.turn.error` | An unhandled error occurred in the CLI loop. |
| `http.request.error` | An unhandled error occurred in an HTTP request handler. |
