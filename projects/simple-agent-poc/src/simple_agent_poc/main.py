"""Entry point for the CLI."""

import logging
from datetime import datetime

from dotenv import load_dotenv

from simple_agent_poc.agent import Agent
from simple_agent_poc.renderer import (
    get_user_input,
    show_agent_response,
    show_error,
    show_exit_message,
    show_welcome,
    with_indicator,
)

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


def main() -> None:
    # UI layer: screen rendering
    show_welcome()

    # Business logic layer: initialize Agent
    # Format system prompt with current datetime before passing to Agent
    formatted_system_prompt = DEFAULT_SYSTEM_PROMPT.format(
        current_datetime=datetime.now().isoformat()
    )
    agent = Agent(
        system_prompt=formatted_system_prompt,
        model=DEFAULT_MODEL,
    )

    # CLI loop
    while True:
        try:
            # UI layer: user input
            user_input = get_user_input()
            if not user_input.strip():
                continue

            # Business logic layer: process request
            response = with_indicator(
                "Thinking",
                lambda: agent.process_user_input(user_input),
            )

            # UI layer: display results
            show_agent_response(response)

        except KeyboardInterrupt:
            show_exit_message()
            break
        except EOFError:
            # Handle EOF (e.g., piped input, terminal closed)
            show_exit_message()
            break
        except Exception as e:
            # UI layer: display user-friendly error message
            show_error(e)


if __name__ == "__main__":
    main()
