# Agent Definition

Agent definitions are loaded from `agents.yaml` by default. Set the `AGENTS_FILE` environment variable to point at a different YAML file.

The canonical source for the YAML schema and validation rules is:
- **`agents.yaml`** — the actual definitions used at runtime
- **`src/simple_agent_poc/core/agent_definition.py`** — parsing and validation logic (`_build_agent_definition`, `_optional_tools`, etc.)

This document explains behaviors that are not obvious from reading the YAML or code alone.

## Field Behaviors

### `model`

LiteLLM model name (e.g. `gpt-4.1-nano`). Passed directly to the LLM client.

### `system_prompt`

Prompt template. The placeholder `{current_datetime}` is replaced with the current ISO 8601 datetime string at session creation time. See `AgentDefinition.format_system_prompt()`.

### `temperature`

When `null` or omitted, the temperature parameter is **not sent** to the LLM API at all (the provider uses its own default). When set, it must be a number (float or int), never a boolean.

### `tools`

A list of tool names as strings (e.g. `[get_current_time, concat, ask_user]`). Each name must correspond to a built-in tool registered in `BuiltinToolRegistry` (see `src/simple_agent_poc/adapters/tools/registry.py`).

Tool names are resolved to `ToolDefinition` objects at request time and passed to the LLM. The LLM may decide to call any of the listed tools during execution.

### `api_type`

| Value | Client | Underlying API |
|:---|:---|:---|
| `"completion"` (default) | `LiteLLMCompletionClient` | `litellm.completion()` |
| `"responses"` | `LiteLLMResponsesClient` | `litellm.responses()` |

The factory selects the client at construction time based on this field.

### `stream`

When `true`, the CLI uses `execute_stream()` with live text output instead of a spinner + synchronous `execute()`. Has no effect on the HTTP API, which always uses streaming for `/api/chat/stream`.

## Validation at Startup

On application startup, `AgentDefinitionRegistry.from_yaml_file()` validates:
- File must be readable and contain valid YAML
- `agents` must be a mapping with string keys, must contain a `default` entry
- Each agent definition must have `model` and `system_prompt` (non-blank strings)
- `tools` must be a list of strings or null
- `api_type` must be `"completion"` or `"responses"`
- Unknown fields at the root or agent level are rejected
- `temperature` must be a number or null; `stream` must be a boolean

For the exact validation logic, see `agent_definition.py` and its `_optional_*` validators.

## Request-time Validation

- `agent_id` not found in the registry → `ValidationError` (HTTP 400)
- A request with `session_id` referencing an existing session that has a different `agent_id` → `ValidationError` (HTTP 400)

## Environment Variable

- `AGENTS_FILE` — path to the YAML file (default: `agents.yaml`)

## Example

See `agents.yaml` in the project root for the canonical example. A minimal definition:

```yaml
agents:
  default:
    model: gpt-4.1-nano
    system_prompt: |
      You are an AI assistant.
      Current datetime: {current_datetime}
    tools:
      - concat
      - ask_user
```
