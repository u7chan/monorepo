"""Shared dependency wiring for entrypoints."""

import logging
import os
from collections.abc import Callable
from pathlib import Path

from dotenv import load_dotenv

from simple_agent_poc.adapters.llm.litellm_client import LiteLLMClientFactory
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.adapters.tools.concat import TOOL_DEFINITION as CONCAT_TOOL_DEF
from simple_agent_poc.adapters.tools.concat import execute as concat_execute
from simple_agent_poc.adapters.tools.get_current_time import (
    TOOL_DEFINITION as TIME_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.get_current_time import (
    execute as time_execute,
)
from simple_agent_poc.adapters.tools.ask_user import (
    TOOL_DEFINITION as ASK_USER_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.ask_user import (
    execute as ask_user_execute,
)
from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
from simple_agent_poc.application.ports import SessionStore, ToolExecutor
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.observability import configure_logging

logging.getLogger("litellm").setLevel(logging.CRITICAL)
logging.getLogger("litellm").addHandler(logging.NullHandler())

load_dotenv()
configure_logging()

DEFAULT_AGENT_ID = "default"
DEFAULT_AGENTS_FILE = Path("agents.yaml")


def create_agent_definition_registry() -> AgentDefinitionRegistry:
    """Load configured agent definitions."""
    agents_file = Path(os.environ.get("AGENTS_FILE", DEFAULT_AGENTS_FILE))
    return AgentDefinitionRegistry.from_yaml_file(agents_file)


def create_default_tool_executor() -> BuiltinToolRegistry:
    """Create a tool registry with built-in tools."""
    registry = BuiltinToolRegistry()
    registry.register(TIME_TOOL_DEF, time_execute)
    registry.register(CONCAT_TOOL_DEF, concat_execute)
    registry.register(ASK_USER_TOOL_DEF, ask_user_execute)
    return registry


def create_run_agent_use_case(
    *,
    session_store: SessionStore | None = None,
    agent_definitions: AgentDefinitionRegistry | None = None,
    tool_executor: ToolExecutor | None = None,
    is_api_context: bool = False,
) -> RunAgentUseCase:
    """Create the shared use case with production dependencies."""
    return RunAgentUseCase(
        llm_client_factory=LiteLLMClientFactory(),
        session_store=session_store or InMemorySessionStore(),
        agent_definitions=agent_definitions or create_agent_definition_registry(),
        tool_executor=tool_executor or create_default_tool_executor(),
        is_api_context=is_api_context,
    )


def create_run_agent_use_case_factory() -> Callable[[], RunAgentUseCase]:
    """Create a use case factory backed by a shared in-memory session store."""
    session_store = InMemorySessionStore()
    agent_definitions = create_agent_definition_registry()
    tool_executor = create_default_tool_executor()
    return lambda: create_run_agent_use_case(
        session_store=session_store,
        agent_definitions=agent_definitions,
        tool_executor=tool_executor,
        is_api_context=True,
    )
