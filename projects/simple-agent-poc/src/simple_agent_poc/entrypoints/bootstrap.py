"""Shared dependency wiring for entrypoints."""

import logging
from collections.abc import Callable
from datetime import datetime

from dotenv import load_dotenv

from simple_agent_poc.adapters.llm.litellm_client import LiteLLMClient
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.ports import SessionStore
from simple_agent_poc.application.use_cases import RunAgentUseCase

logging.getLogger("litellm").setLevel(logging.CRITICAL)
logging.getLogger("litellm").addHandler(logging.NullHandler())

load_dotenv()

DEFAULT_SYSTEM_PROMPT = """You are an AI assistant designed to help users with various tasks.

Guidelines:
1. Be helpful, accurate, and concise
2. Provide clear explanations when needed
3. Admit when you don't know something
4. Maintain a professional and friendly tone
5. Use the current temporal context when relevant to the user's query.

Current datetime: {current_datetime}
"""

DEFAULT_MODEL = "gpt-4.1-nano"


def create_run_agent_use_case(
    *,
    session_store: SessionStore | None = None,
) -> RunAgentUseCase:
    """Create the shared use case with production dependencies."""
    formatted_system_prompt = DEFAULT_SYSTEM_PROMPT.format(
        current_datetime=datetime.now().isoformat()
    )
    return RunAgentUseCase(
        llm_client=LiteLLMClient(model=DEFAULT_MODEL),
        session_store=session_store or InMemorySessionStore(),
        system_prompt=formatted_system_prompt,
    )


def create_run_agent_use_case_factory() -> Callable[[], RunAgentUseCase]:
    """Create a use case factory backed by a shared in-memory session store."""
    session_store = InMemorySessionStore()
    return lambda: create_run_agent_use_case(session_store=session_store)
