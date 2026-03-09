"""Conversation session entities."""

from dataclasses import dataclass, field

from simple_agent_poc.core.types import Message


@dataclass(slots=True)
class ConversationSession:
    """Conversation history identified by a session id."""

    session_id: str
    messages: list[Message] = field(default_factory=list)

    @classmethod
    def start(cls, *, session_id: str, system_prompt: str) -> "ConversationSession":
        """Create a new session with its initial system prompt."""
        return cls(
            session_id=session_id,
            messages=[{"role": "system", "content": system_prompt}],
        )

    def append_user_message(self, content: str) -> None:
        """Append a user message to the conversation."""
        self.messages.append({"role": "user", "content": content})

    def append_assistant_message(self, content: str) -> None:
        """Append an assistant message to the conversation."""
        self.messages.append({"role": "assistant", "content": content})
