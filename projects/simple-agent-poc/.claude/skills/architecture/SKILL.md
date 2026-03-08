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

- `src/simple_agent_poc/main.py`
  - CLI entrypoint
  - environment loading and logging setup
  - system prompt and model configuration
  - agent construction
  - interactive loop and error handling
- `src/simple_agent_poc/renderer.py`
  - CLI input/output only
  - loading indicator for synchronous terminal usage
- `src/simple_agent_poc/agent.py`
  - conversation state management
  - orchestration of the LLM client call
- `src/simple_agent_poc/llm_client.py`
  - infrastructure adapter for LiteLLM
  - exception translation
- `src/simple_agent_poc/interfaces.py`
  - protocol contract for the LLM client
- `src/simple_agent_poc/types.py`
  - shared DTO-like types and domain/application errors

The main coupling that blocks multi-entry support today is that `main.py` directly owns the
interactive flow and constructs `Agent` as the executable application flow. That keeps the CLI
fast to iterate on, but it leaves no reusable use case boundary for an HTTP adapter.

## Target layers

### Core

Owns agent behavior that is independent of transport or entrypoint concerns.

- conversation state transitions
- message accumulation rules
- domain-level validation
- abstractions needed by higher layers

Core must not depend on CLI or HTTP details.

### Application

Owns executable use cases and explicit input/output contracts.

- `RunAgentUseCase`
- request and response DTOs
- application orchestration across core and infrastructure ports

Application may depend on core contracts, but must not perform terminal rendering or HTTP
response construction.

### Adapters

Own transport-specific integration details.

- CLI adapter for stdin/stdout interaction
- HTTP adapter for request parsing and response serialization
- infrastructure adapters such as LiteLLM

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
3. Expose the reusable execution path as an application use case, not as a CLI helper.
4. Define conversation and session state policy at the application/core boundary and let adapters consume it.
5. Inject infrastructure clients through interfaces so the same use case works for CLI and HTTP.

## Directory direction

The next refactor should be incremental rather than a full rewrite. The intended structure is:

```text
src/simple_agent_poc/
  core/
  application/
  adapters/
    cli/
    http/
    llm/
  entrypoints/
    main_cli.py
    main_api.py
```

Migration guidance:

1. Introduce the application use case and DTOs first.
2. Move CLI interaction behind a CLI adapter that calls the use case.
3. Add the HTTP adapter only after the shared use case path exists.
4. Split existing modules into the new folders only when each move has a clear owner.

## Mapping from current code

- `agent.py` is the nearest precursor to the future core/application split.
  - conversation state should trend toward `core`
  - execution orchestration should trend toward `application`
- `renderer.py` should remain CLI-specific and move under `adapters/cli`
- `llm_client.py` should remain an adapter and move under `adapters/llm`
- `main.py` should be split into an entrypoint and CLI adapter responsibilities

## Non-goals

- Do not introduce every future layer immediately.
- Do not redesign the runtime around async or streaming yet.
- Do not change the CLI-first development workflow.
