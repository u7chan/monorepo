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
def create_run_agent_use_case(*, session_store=None, agent_definitions=None) -> RunAgentUseCase:
    return RunAgentUseCase(
        llm_client_factory=LiteLLMClientFactory(),
        session_store=session_store or InMemorySessionStore(),
        agent_definitions=agent_definitions or create_agent_definition_registry(),
    )
```

Creates the use case with production adapters:
- `LiteLLMClientFactory()` for LLM calls
- `InMemorySessionStore()` for session persistence
- `AgentDefinitionRegistry` from YAML

## RunAgentUseCase Factory (HTTP-optimized)

```python
def create_run_agent_use_case_factory() -> Callable[[], RunAgentUseCase]:
    session_store = InMemorySessionStore()
    agent_definitions = create_agent_definition_registry()
    return lambda: create_run_agent_use_case(
        session_store=session_store,
        agent_definitions=agent_definitions,
    )
```

Creates a factory function that:
- Shares a single `InMemorySessionStore` instance across all invocations.
- Shares a single `AgentDefinitionRegistry` instance.
- Returns a `lambda` for use with FastAPI's `Depends`.

This ensures that HTTP requests against the same server process share the same in-memory sessions.

## Startup Sequences

### CLI

```
main_cli.py
  → build_cli_adapter(agent_id)
    → bootstrap.create_agent_definition_registry()     # load YAML
    → bootstrap.create_run_agent_use_case(...)          # wire use case (new session store)
    → CLIAdapter(use_case, agent_id, agent_definitions)
      → adapter.run()                                   # interactive loop
```

### HTTP API

```
main_api.py
  → create_app()  (no factory arg)
    → bootstrap.create_run_agent_use_case_factory()     # shared session store + registry
      → FastAPI app with get_run_agent_use_case() dependency

Request handling:
  Depends(get_run_agent_use_case) → factory() → RunAgentUseCase
    → use_case.execute(request) or execute_stream(request)
```
