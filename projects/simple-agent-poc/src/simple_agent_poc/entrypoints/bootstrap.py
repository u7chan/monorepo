"""Shared dependency wiring for entrypoints."""

import logging
import os
from collections.abc import Callable
from pathlib import Path

from dotenv import load_dotenv

from simple_agent_poc.adapters.llm.litellm_client import LiteLLMClientFactory
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.ports import SessionStore
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry

logging.getLogger("litellm").setLevel(logging.CRITICAL)
logging.getLogger("litellm").addHandler(logging.NullHandler())

load_dotenv()

DEFAULT_AGENT_ID = "default"
DEFAULT_AGENTS_FILE = Path("agents.yaml")


def create_agent_definition_registry() -> AgentDefinitionRegistry:
    """Load configured agent definitions."""
    agents_file = Path(os.environ.get("AGENTS_FILE", DEFAULT_AGENTS_FILE))
    return AgentDefinitionRegistry.from_yaml_file(agents_file)


def create_run_agent_use_case(
    *,
    session_store: SessionStore | None = None,
    agent_definitions: AgentDefinitionRegistry | None = None,
) -> RunAgentUseCase:
    """Create the shared use case with production dependencies."""
    return RunAgentUseCase(
        llm_client_factory=LiteLLMClientFactory(),
        session_store=session_store or InMemorySessionStore(),
        agent_definitions=agent_definitions or create_agent_definition_registry(),
    )


def create_run_agent_use_case_factory() -> Callable[[], RunAgentUseCase]:
    """Create a use case factory backed by a shared in-memory session store."""
    session_store = InMemorySessionStore()
    agent_definitions = create_agent_definition_registry()
    return lambda: create_run_agent_use_case(
        session_store=session_store,
        agent_definitions=agent_definitions,
    )
