"""UI rendering functions for CLI output."""

import sys
import threading
import time
from typing import Callable

from simple_agent_poc.types import AgentError, LLMResponse


class LoadingIndicator:
    """Async loading indicator for CLI."""

    def __init__(self, message: str = "Thinking") -> None:
        self.message = message
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._spinner_chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def _run(self) -> None:
        """Run the spinner animation."""
        idx = 0
        while not self._stop_event.is_set():
            char = self._spinner_chars[idx % len(self._spinner_chars)]
            sys.stdout.write(f"\r{char} {self.message}...")
            sys.stdout.flush()
            idx += 1
            time.sleep(0.08)
        # Clear the line when stopped
        sys.stdout.write("\r" + " " * (len(self.message) + 10) + "\r")
        sys.stdout.flush()

    def start(self) -> None:
        """Start the loading indicator."""
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run)
        self._thread.start()

    def stop(self) -> None:
        """Stop the loading indicator."""
        self._stop_event.set()
        if self._thread:
            self._thread.join()


def with_indicator[T](message: str, operation: Callable[[], T]) -> T:
    """Execute an operation with a loading indicator.

    Args:
        message: The message to display next to the spinner.
        operation: The function to execute while showing the indicator.

    Returns:
        The result of the operation.
    """
    indicator = LoadingIndicator(message)
    indicator.start()
    try:
        return operation()
    finally:
        indicator.stop()


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
