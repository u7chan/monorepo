"""Conversation session entities."""

from dataclasses import dataclass, field

from simple_agent_poc.core.types import Message, ToolCall


@dataclass(slots=True)
class ConversationSession:
    """Conversation history identified by a session id."""

    session_id: str
    agent_id: str = "default"
    messages: list[Message] = field(default_factory=list)
    is_paused: bool = False
    pending_tool_call: ToolCall | None = None
    pending_round: int = 0

    @classmethod
    def start(
        cls,
        *,
        session_id: str,
        agent_id: str = "default",
        system_prompt: str,
    ) -> "ConversationSession":
        """Create a new session with its initial system prompt."""
        return cls(
            session_id=session_id,
            agent_id=agent_id,
            messages=[{"role": "system", "content": system_prompt}],
        )

    def append_user_message(self, content: str) -> None:
        """Append a user message to the conversation."""
        self.messages.append({"role": "user", "content": content})

    def append_assistant_message(
        self,
        content: str,
        *,
        tool_calls: list[ToolCall] | None = None,
    ) -> None:
        """Append an assistant message, optionally with tool calls."""
        msg: Message = {"role": "assistant", "content": content}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        self.messages.append(msg)

    def append_tool_message(self, content: str, *, tool_call_id: str) -> None:
        """Append a tool result message to the conversation."""
        self.messages.append(
            {
                "role": "tool",
                "content": content,
                "tool_call_id": tool_call_id,
            }
        )

    def pause_for_ask_user(self, tool_call: ToolCall, *, round_idx: int) -> None:
        """Transition to paused state waiting for user answer."""
        self.is_paused = True
        self.pending_tool_call = tool_call
        self.pending_round = round_idx

    def resume_with_answer(self) -> None:
        """Clear paused state after receiving user answer."""
        self.is_paused = False
        self.pending_tool_call = None
        self.pending_round = 0
