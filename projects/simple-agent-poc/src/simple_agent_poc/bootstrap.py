"""Shared dependency wiring for entrypoints."""

import logging
from datetime import datetime

from dotenv import load_dotenv

from simple_agent_poc.agent import Agent
from simple_agent_poc.application import RunAgentUseCase

# Suppress LiteLLM logging to stderr
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


def create_run_agent_use_case() -> RunAgentUseCase:
    """Create the shared use case with production dependencies."""
    formatted_system_prompt = DEFAULT_SYSTEM_PROMPT.format(
        current_datetime=datetime.now().isoformat()
    )
    agent = Agent(
        system_prompt=formatted_system_prompt,
        model=DEFAULT_MODEL,
    )
    return RunAgentUseCase(agent)
