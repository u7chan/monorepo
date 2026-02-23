"""UI rendering functions for CLI output."""

from simple_agent_poc.types import AgentError, LLMResponse


def show_error(error: Exception) -> None:
    """Display an error message to the user.

    Shows a user-friendly message for known error types,
    or a generic message for unexpected errors.
    """
    if isinstance(error, AgentError):
        print(f"⚠️  Error: {error.display_message}")
    else:
        print(f"⚠️  Error: An unexpected error occurred: {error}")


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
