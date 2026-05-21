"""UI rendering functions for CLI output."""

import json
import sys
import threading
import time
from collections.abc import Generator
from typing import Callable

from simple_agent_poc.application.dto import (
    ContentDelta,
    RunAgentResponse,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.core.types import AgentError


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
    """Execute an operation with a loading indicator."""
    indicator = LoadingIndicator(message)
    indicator.start()
    try:
        return operation()
    finally:
        indicator.stop()


def show_error(error: Exception) -> None:
    """Display an error message to the user."""
    if isinstance(error, AgentError):
        print(f"⚠️  Error: {error.display_message}")
    else:
        print(f"⚠️  Error: An unexpected error occurred: {error}")


def show_welcome(agent_id: str = "default") -> None:
    """Display the welcome banner."""
    print("═" * 40)
    print("  ✨  Welcome to Simple Agent POC  ✨")
    print("     (Press Ctrl+C to exit)")
    print(f"     AgentId: {agent_id}")
    print("═" * 40)
    print()


def get_user_input() -> str:
    """Get user input and return the input string."""
    return input("> ")


def ask_user_question(questions: list[dict]) -> dict[str, str]:
    """Display ask_user questions sequentially and return all answers.

    Supports up to 4 questions per batch.  Each question is displayed
    one at a time and the user's answer is collected before moving on.
    """
    answers: dict[str, str] = {}
    if not questions:
        return answers

    for i, q in enumerate(questions):
        header = q.get("header", "")
        question_text = q.get("question", "")
        q_type = q.get("type", "text")
        placeholder = q.get("placeholder", "")
        options = q.get("options", [])
        multi_select = q.get("multiSelect", False)
        label = f"[{header}] " if header else ""

        total = len(questions)
        prefix = f"({i + 1}/{total}) " if total > 1 else ""

        if q_type == "choice" and options:
            print(f"  {prefix}{label}{question_text}")
            for idx, opt in enumerate(options, start=1):
                desc = opt.get("description", "")
                line = f"    {idx}. {opt['label']}"
                if desc:
                    line += f" — {desc}"
                print(line)
            if multi_select:
                prompt = "  選択（カンマ区切りで複数可）> "
            else:
                prompt = "  選択（番号または自由記述）> "
        else:
            prompt = f"  {prefix}{label}{question_text}"
            if placeholder:
                prompt += f" ({placeholder})"
            prompt += " > "

        answers[question_text] = input(prompt).strip()

    return answers


def show_agent_response(response: RunAgentResponse) -> None:
    """Display the agent's response."""
    if response.tool_call_history:
        print("Agent: ")
        for tc in response.tool_call_history:
            result_text = tc.result.replace("\n", "\n     → ")
            print(f"  🔧 {tc.name}({tc.arguments})")
            print(f"     → {result_text}")
        if response.message:
            print(f"       {response.message}")
    else:
        print(f"Agent: {response.message}")

    elapsed = response.response_time
    if elapsed < 1:
        time_str = f"{elapsed * 1000:.0f}ms"
    else:
        time_str = f"{elapsed:.2f}s"

    model = response.model
    if "/" in model:
        model = model.split("/")[-1]

    usage = response.usage
    stats = (
        f"Model: {model} │ "
        f"Time: {time_str} │ "
        f"Tokens: {usage['prompt_tokens']} → {usage['completion_tokens']} "
        f"(total: {usage['total_tokens']})"
    )

    print(f"  └─ {stats}")


def show_exit_message() -> None:
    """Display the exit message."""
    print("\nExiting...")


def show_streaming_response(
    stream: Generator[
        ContentDelta | ToolCallEvent | ToolResultEvent | SessionPaused | StreamComplete,
        dict[str, str] | None,
        None,
    ],
) -> StreamComplete:
    """Display a streaming response with live output.

    When an ask_user ToolCallEvent arrives, the generator pauses.
    The user is prompted for input and ``generator.send(answer)``
    resumes the generator with the answer.
    """
    indicator = LoadingIndicator()
    indicator.start()
    try:
        complete: StreamComplete | None = None
        started = False

        event: (
            ContentDelta
            | ToolCallEvent
            | ToolResultEvent
            | SessionPaused
            | StreamComplete
            | None
        ) = None

        while complete is None:
            try:
                event = next(stream)
            except StopIteration:
                break

            if isinstance(event, ContentDelta):
                if not started:
                    indicator.stop()
                    sys.stdout.write("Agent: ")
                    started = True
                sys.stdout.write(event.delta)
                sys.stdout.flush()
            elif isinstance(event, ToolCallEvent):
                if not started:
                    indicator.stop()
                    sys.stdout.write("Agent: ")
                    started = True
                sys.stdout.write(f"\n  🔧 {event.name}({event.arguments})")
                sys.stdout.flush()

                if event.name == "ask_user":
                    args = json.loads(event.arguments)
                    answers = ask_user_question(args.get("questions", []))
                    try:
                        next_event = stream.send(answers)
                    except StopIteration:
                        break
                    if isinstance(next_event, ToolResultEvent):
                        result_text = next_event.result.replace("\n", "\n     → ")
                        sys.stdout.write(f"\n     → {result_text}")
                        sys.stdout.flush()
                    continue
            elif isinstance(event, ToolResultEvent):
                if not started:
                    indicator.stop()
                    sys.stdout.write("Agent: ")
                    started = True
                result_text = event.result.replace("\n", "\n     → ")
                sys.stdout.write(f"\n     → {result_text}")
                sys.stdout.flush()
            elif isinstance(event, SessionPaused):
                indicator.stop()
                questions = event.questions
                if questions:
                    q = questions[0]
                    header = q.get("header", "")
                    question_text = q.get("question", "")
                    label = f"[{header}] " if header else ""
                    sys.stdout.write(f"\n  💬 ask_user: {label}{question_text}\n")
                    sys.stdout.flush()
            elif isinstance(event, StreamComplete):
                complete = event
                if not started:
                    indicator.stop()
                    sys.stdout.write("Agent: ")
                sys.stdout.write("\n")
                sys.stdout.flush()

                elapsed = complete.response_time
                if elapsed < 1:
                    time_str = f"{elapsed * 1000:.0f}ms"
                else:
                    time_str = f"{elapsed:.2f}s"

                model = complete.model
                if "/" in model:
                    model = model.split("/")[-1]

                usage = complete.usage
                if usage is not None:
                    stats = (
                        f"Model: {model} │ "
                        f"Time: {time_str} │ "
                        f"Tokens: {usage['prompt_tokens']} → {usage['completion_tokens']} "
                        f"(total: {usage['total_tokens']})"
                    )
                else:
                    stats = f"Model: {model} │ Time: {time_str}"
                print(f"  └─ {stats}")

        if complete is None:
            raise RuntimeError("Stream ended without StreamComplete event")
        return complete
    except Exception:
        indicator.stop()
        raise
