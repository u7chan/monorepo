---
name: architecture
description: Defines the multi-entry architecture boundaries for simple-agent-poc.
---

## Purpose

Use this skill when implementing or refactoring `simple-agent-poc` so the project keeps the CLI
as the primary development entrypoint while separating reusable application flow from
entrypoint-specific concerns.

## Current responsibility audit

Current files and responsibilities:

- `src/simple_agent_poc/entrypoints/main_cli.py`
  - CLI entrypoint wiring
  - CLI adapter composition
- `src/simple_agent_poc/entrypoints/main_api.py`
  - HTTP API entrypoint wiring
  - Uvicorn startup wiring
- `src/simple_agent_poc/entrypoints/bootstrap.py`
  - shared environment loading and logging setup
  - system prompt and model configuration
  - shared `RunAgentUseCase` construction
  - process-wide in-memory session store composition for HTTP
- `src/simple_agent_poc/adapters/cli/adapter.py`
  - CLI adapter for interactive execution
  - stdin/stdout interaction loop
  - CLI-specific exception handling and user-facing messaging
  - CLI-side current `session_id` tracking
  - delegation from terminal input to `RunAgentUseCase`
- `src/simple_agent_poc/adapters/cli/renderer.py`
  - CLI input/output only
  - loading indicator for synchronous terminal usage
- `src/simple_agent_poc/adapters/http/api.py`
  - HTTP adapter for FastAPI request parsing and response serialization
  - HTTP status mapping for session-related errors
  - delegation from HTTP requests to `RunAgentUseCase`
- `src/simple_agent_poc/adapters/llm/litellm_client.py`
  - infrastructure adapter for LiteLLM
  - exception translation
- `src/simple_agent_poc/adapters/session_store/in_memory.py`
  - in-process session persistence
  - current default session store implementation
- `src/simple_agent_poc/application/dto.py`
  - request and response DTOs for the reusable execution contract
- `src/simple_agent_poc/application/ports.py`
  - protocol contracts for `LLMClient` and `SessionStore`
- `src/simple_agent_poc/application/use_cases.py`
  - session-aware execution orchestration
  - new session creation and existing session loading
  - LLM invocation and response persistence
- `src/simple_agent_poc/core/session.py`
  - conversation session entity
  - ordered message accumulation rules
- `src/simple_agent_poc/core/types.py`
  - shared message and response types
  - domain/application-facing errors including session lookup failures

The current structure now separates entrypoint wiring, application orchestration, transport
adapters, and session state boundaries. Future work should preserve that split and keep new
session or persistence behavior behind the existing application ports.

## Target layers

### Core

Owns agent behavior that is independent of transport or entrypoint concerns.

- conversation session state transitions
- message accumulation rules
- core domain errors and shared message types
- abstractions needed by higher layers

Core must not depend on CLI or HTTP details.

### Application

Owns executable use cases and explicit input/output contracts.

- `RunAgentUseCase`
- request and response DTOs
- application orchestration across core and infrastructure ports
- `SessionStore` and `LLMClient` interfaces

Application may depend on core contracts, but must not perform terminal rendering or HTTP
response construction.

### Adapters

Own transport-specific integration details.

- CLI adapter for stdin/stdout interaction
- HTTP adapter for request parsing and response serialization
- infrastructure adapters such as LiteLLM and in-memory session storage

Adapters call the application layer. They translate external inputs into DTOs and translate use
case outputs into transport-specific output.

### Entrypoints

Own process startup and dependency wiring.

- `main_cli` initializes the CLI adapter and application dependencies
- `main_api` initializes the HTTP adapter and application dependencies

Entrypoints should stay thin. Their job is composition, not business logic.

## Boundary rules

1. Keep CLI rendering outside the application and core layers.
2. Keep HTTP request and response objects outside the application and core layers.
3. Expose the reusable execution path as an application use case, not as a CLI or HTTP helper.
4. Define conversation and session state policy at the application/core boundary and let adapters consume it.
5. Keep session persistence behind `SessionStore`; adapters may choose identifiers, but they must not own message history.
6. Inject infrastructure clients through interfaces so the same use case works for CLI and HTTP.

## Current directory shape

The project currently uses this structure:

```text
src/simple_agent_poc/
  core/
    session.py
    types.py
  application/
    dto.py
    ports.py
    use_cases.py
  adapters/
    cli/
      adapter.py
      renderer.py
    http/
      api.py
    llm/
      litellm_client.py
    session_store/
      in_memory.py
  entrypoints/
    bootstrap.py
    main_cli.py
    main_api.py
```

## Ongoing guidance

1. Extend session behavior in `core` and `application` before adding adapter-specific conveniences.
2. Keep CLI-specific state limited to the active `session_id`; do not move message history back into the CLI adapter.
3. Keep HTTP-specific concerns limited to schema validation and status-code translation.
4. Add durable persistence by creating a new `adapters/session_store/*` implementation rather than changing use-case semantics.
5. Keep `entrypoints/bootstrap.py` as the only place that decides production adapter composition.

## Mapping from current code

- `core/session.py` owns ordered conversation history and system/user/assistant message accumulation.
- `application/use_cases.py` owns session lookup, session creation, LLM orchestration, and persistence sequencing.
- `application/ports.py` is the only boundary that application code uses for LLM and session persistence.
- `adapters/cli/adapter.py` owns the interactive loop and passes the current `session_id` through the use case.
- `adapters/http/api.py` owns request parsing and translates `SessionNotFoundError` into `404`.
- `adapters/session_store/in_memory.py` is the reference implementation for persistence adapters.
- `entrypoints/bootstrap.py` owns production wiring used by both CLI and HTTP.

## Non-goals

- Do not introduce every future layer immediately.
- Do not redesign the runtime around async or streaming yet.
- Do not change the CLI-first development workflow.
- Do not couple future persistence work to FastAPI or terminal concerns.
