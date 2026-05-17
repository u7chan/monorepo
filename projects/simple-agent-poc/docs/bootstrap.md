# Bootstrap / Dependency Injection

The bootstrap module is the single source of truth for production dependency wiring. Both CLI and HTTP entrypoints use it.

Source: `src/simple_agent_poc/entrypoints/bootstrap.py`

## Environment Loading

```python
load_dotenv()  # loads .env into os.environ
```

Called once at module level. Required environment variables:
- `OPENAI_API_KEY` — LLM provider API key
- `OPENAI_BASE_URL` — LLM provider base URL (optional, used by LiteLLM)

## Built-in Tool Executor

```python
def create_default_tool_executor() -> BuiltinToolRegistry:
    return BuiltinToolRegistry.with_default_tools()
```

Creates a `BuiltinToolRegistry` with the following built-in tools registered:
- `get_current_time` — returns the current UTC datetime in ISO 8601 format
- `concat` — concatenates two strings
- `ask_user` — asks the user a question and returns their answer (interactive)

Tool definitions are in `src/simple_agent_poc/adapters/tools/`. Each tool module exports a `TOOL_DEFINITION` constant and an `execute` function.

## Agent Definition Registry

```python
def create_agent_definition_registry() -> AgentDefinitionRegistry:
    agents_file = Path(os.environ.get("AGENTS_FILE", DEFAULT_AGENTS_FILE))
    return AgentDefinitionRegistry.from_yaml_file(agents_file)
```

- Reads the path from `AGENTS_FILE` env var.
- Default: `Path("agents.yaml")`.
- Validates the YAML at construction time.

## RunAgentUseCase (Production)

```python
def create_run_agent_use_case(
    *,
    session_store=None,
    agent_definitions=None,
    tool_executor=None,
    is_api_context: bool = False,
) -> RunAgentUseCase:
    return RunAgentUseCase(
        llm_client_factory=LiteLLMClientFactory(),
        session_store=session_store or InMemorySessionStore(),
        agent_definitions=agent_definitions or create_agent_definition_registry(),
        tool_executor=tool_executor or create_default_tool_executor(),
        is_api_context=is_api_context,
    )
```

Creates the use case with production adapters:
- `LiteLLMClientFactory()` for LLM calls
- `InMemorySessionStore()` for session persistence
- `AgentDefinitionRegistry` from YAML
- `BuiltinToolRegistry` with default tools
- `is_api_context=False` for CLI, `True` for HTTP API (controls `ask_user` behavior)

## RunAgentUseCase Factory (HTTP-optimized)

```python
def create_run_agent_use_case_factory() -> Callable[[], RunAgentUseCase]:
    session_store = InMemorySessionStore()
    agent_definitions = create_agent_definition_registry()
    tool_executor = create_default_tool_executor()
    return lambda: create_run_agent_use_case(
        session_store=session_store,
        agent_definitions=agent_definitions,
        tool_executor=tool_executor,
        is_api_context=True,
    )
```

Creates a factory function that:
- Shares a single `InMemorySessionStore` instance across all invocations.
- Shares a single `AgentDefinitionRegistry` instance.
- Shares a single `BuiltinToolRegistry` instance.
- Sets `is_api_context=True` so `ask_user` uses pause/resume instead of `generator.send()`.
- Returns a `lambda` for use with FastAPI's `Depends`.

## Startup Sequences

### CLI

```
main_cli.py
  → build_cli_adapter(agent_id)
    → bootstrap.create_agent_definition_registry()     # load YAML
    → bootstrap.create_default_tool_executor()          # create tool registry
    → bootstrap.create_run_agent_use_case(...)          # wire use case (new session store)
    → CLIAdapter(use_case, agent_id, agent_definitions)
      → adapter.run()                                   # interactive loop
```

### HTTP API

```
main_api.py
  → create_app()  (no factory arg)
    → bootstrap.create_run_agent_use_case_factory()     # shared session store + registry + tools
      → FastAPI app with get_run_agent_use_case() dependency

Request handling:
  Depends(get_run_agent_use_case) → factory() → RunAgentUseCase
    → use_case.execute(request) or execute_stream(request)
```
