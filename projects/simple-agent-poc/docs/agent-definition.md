# Agent Definition

Agent definitions are loaded from `agents.yaml` by default. Set the `AGENTS_FILE` environment variable to point at a different YAML file.

## YAML Schema

```yaml
agents:
  <agent_id>:
    model: <string>           # required
    system_prompt: <string>   # required
    temperature: <float|null> # optional, default null
    tools: <list>            # optional, default []
    api_type: <string>       # optional, default "completion"
    stream: <bool>           # optional, default false
```

### Root Fields

| Field | Required | Type | Description |
|:---|:---|:---|:---|
| `agents` | yes | `Mapping[str, Mapping]` | Map of agent IDs to their definitions |

Unknown root-level fields are rejected.

### Agent Fields

#### `model` (required)

- **Type:** `str` (non-blank)
- **Description:** LiteLLM model name (e.g. `gpt-4.1-nano`).

#### `system_prompt` (required)

- **Type:** `str` (non-blank)
- **Description:** Prompt template for the agent. The placeholder `{current_datetime}` is replaced with the current ISO datetime at session creation time.

#### `temperature` (optional)

- **Type:** `float | null`
- **Default:** `null`
- **Description:** When `null` or omitted, the temperature parameter is not sent to the LLM API. When set, it must be a number (not a boolean).

#### `tools` (optional)

- **Type:** `list[dict] | null`
- **Default:** `[]`
- **Description:** Reserved for future tool-calling support. Currently parsed and validated but not passed to LiteLLM.

#### `api_type` (optional)

- **Type:** `"completion" | "responses"`
- **Default:** `"completion"`
- **Description:** Chooses the LiteLLM client implementation:
  - `completion` → `LiteLLMCompletionClient` (uses `litellm.completion()`)
  - `responses` → `LiteLLMResponsesClient` (uses `litellm.responses()`)

#### `stream` (optional)

- **Type:** `bool`
- **Default:** `false`
- **Description:** When `true`, the CLI uses `execute_stream` with live text output instead of spinner+sync execution.

## Validation Rules

### Startup Validation

On application startup, `AgentDefinitionRegistry.from_yaml_file()` validates:

1. File must be readable and contain valid YAML.
2. Root must be a mapping with string keys.
3. Unknown root fields are rejected.
4. `agents` must be a mapping.
5. A `default` agent is required. Missing it raises `ValidationError`.
6. Each agent ID must be a non-blank string.
7. `model` and `system_prompt` are required for each agent.
8. Unknown fields in an agent definition are rejected.
9. `temperature` must be a number or null.
10. `tools` must be a list of mappings or null.
11. `api_type` must be `"completion"` or `"responses"`.
12. `stream` must be a boolean.

### Request-time Validation

- `agent_id` not found in the registry → `ValidationError` (HTTP 400)
- A request with `session_id` referencing an existing session that has a different `agent_id` → `ValidationError` (HTTP 400)

## Environment Variable

- `AGENTS_FILE` — path to the YAML file (default: `agents.yaml`)

## Example

```yaml
agents:
  default:
    model: gpt-4.1-nano
    stream: false
    system_prompt: |
      You are an AI assistant.
      Current datetime: {current_datetime}
    temperature: null
    tools: []
    api_type: completion

  kansaiben:
    model: gpt-5.4-nano
    stream: true
    system_prompt: |
      関西弁で話してや。
      Current datetime: {current_datetime}
    temperature: null
    tools: []
    api_type: responses
```
