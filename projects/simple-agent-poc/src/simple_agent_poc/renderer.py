"""UI rendering functions for CLI output.

This module handles all screen output (user-facing display).
For internal logging, use the logging module.
"""

from simple_agent_poc.types import LLMResponse


def show_welcome() -> None:
    """Display the welcome banner."""
    print("═" * 40)
    print("  ✨  Welcome to Simple Agent POC  ✨")
    print("     (Press Ctrl+C to exit)")
    print("═" * 40)
    print()


def get_user_input() -> str:
    """Get user input and return the input string.

    Returns empty string if input is empty.
    """
    return input("> ")


def show_agent_response(response: LLMResponse) -> None:
    """Display the agent's response."""
    print(f"Agent: {response['content']}")
    print(
        f"[Usage: Input={response['usage']['prompt_tokens']}, "
        f"Output={response['usage']['completion_tokens']}, "
        f"Total={response['usage']['total_tokens']} tokens]"
    )


def show_exit_message() -> None:
    """Display the exit message."""
    print("\nExiting...")
