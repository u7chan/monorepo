# Architecture

`simple-agent-poc` is a multi-entry AI agent application following Clean Architecture with four distinct layers. The same agent execution flow is reused by both CLI and HTTP adapters.

## Layer Dependency Direction

```
entrypoints/  →  adapters/  →  application/  →  core/
```

Dependencies flow inward. Outer layers may depend on inner layers, but not the reverse.

## Layers

### Core

Owns agent behavior independent of transport or entrypoint concerns.

**Files:**
- `src/simple_agent_poc/core/types.py` — shared message/response types, domain errors
- `src/simple_agent_poc/core/session.py` — `ConversationSession` entity
- `src/simple_agent_poc/core/agent_definition.py` — `AgentDefinition`, `AgentDefinitionRegistry`

Core must not depend on CLI or HTTP details.

### Application

Owns executable use cases and explicit input/output contracts.

**Files:**
- `src/simple_agent_poc/application/use_cases.py` — `RunAgentUseCase` (orchestration)
- `src/simple_agent_poc/application/dto.py` — request/response DTOs, stream events
- `src/simple_agent_poc/application/ports.py` — `LLMClient`, `LLMClientFactory`, `SessionStore` protocols

Application may depend on core contracts, but must not perform terminal rendering or HTTP response construction.

### Adapters

Own transport-specific integration details.

**Files:**
- `src/simple_agent_poc/adapters/cli/adapter.py` — `CLIAdapter` (stdin/stdout interactive loop)
- `src/simple_agent_poc/adapters/cli/renderer.py` — spinner, streaming display, welcome banner
- `src/simple_agent_poc/adapters/http/api.py` — FastAPI app (`/api/chat`, `/api/chat/stream`)
- `src/simple_agent_poc/adapters/llm/litellm_client.py` — `LiteLLMCompletionClient`, `LiteLLMResponsesClient`, `LiteLLMClientFactory`
- `src/simple_agent_poc/adapters/session_store/in_memory.py` — `InMemorySessionStore`

Adapters call the application layer. They translate external inputs into DTOs and translate use case outputs into transport-specific output.

### Entrypoints

Own process startup and dependency wiring.

**Files:**
- `src/simple_agent_poc/entrypoints/bootstrap.py` — shared env loading, logging setup, `RunAgentUseCase` wiring
- `src/simple_agent_poc/entrypoints/main_cli.py` — CLI startup
- `src/simple_agent_poc/entrypoints/main_api.py` — HTTP API startup (Uvicorn)

Entrypoints should stay thin. Their job is composition, not business logic.

## Boundary Rules

1. Keep CLI rendering outside the application and core layers.
2. Keep HTTP request and response objects outside the application and core layers.
3. Expose the reusable execution path as an application use case, not as a CLI or HTTP helper.
4. Define conversation and session state policy at the application/core boundary and let adapters consume it.
5. Keep session persistence behind `SessionStore`; adapters may choose identifiers, but they must not own message history.
6. Inject infrastructure clients through interfaces so the same use case works for CLI and HTTP.

## Current Directory Structure

```text
src/simple_agent_poc/
  core/
    session.py
    types.py
    agent_definition.py
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

## Responsibility Audit

- `core/session.py` — ordered conversation history, system/user/assistant message accumulation.
- `application/use_cases.py` — session lookup, session creation, LLM orchestration, persistence sequencing.
- `application/ports.py` — the only boundary that application code uses for LLM and session persistence.
- `adapters/cli/adapter.py` — interactive loop, delegates to `RunAgentUseCase`, tracks `_session_id`.
- `adapters/http/api.py` — request parsing, translates `SessionNotFoundError` into `404`, SSE formatting.
- `adapters/session_store/in_memory.py` — reference implementation for persistence adapters.
- `entrypoints/bootstrap.py` — production wiring used by both CLI and HTTP.

## Ongoing Guidance

1. Extend session behavior in `core` and `application` before adding adapter-specific conveniences.
2. Keep CLI-specific state limited to the active `session_id`; do not move message history back into the CLI adapter.
3. Keep HTTP-specific concerns limited to schema validation and status-code translation.
4. Add durable persistence by creating a new `adapters/session_store/*` implementation rather than changing use-case semantics.
5. Keep `entrypoints/bootstrap.py` as the only place that decides production adapter composition.

## Non-goals

- Do not introduce every future layer immediately.
- Do not redesign the runtime around async yet.
- Do not change the CLI-first development workflow.
- Do not couple future persistence work to FastAPI or terminal concerns.
