"""In-memory session store."""

from simple_agent_poc.application.ports import SessionStore
from simple_agent_poc.core.session import ConversationSession


class InMemorySessionStore(SessionStore):
    """Store sessions in process memory."""

    def __init__(self) -> None:
        self._sessions: dict[str, ConversationSession] = {}

    def get(self, session_id: str) -> ConversationSession | None:
        """Return a stored session if present."""
        return self._sessions.get(session_id)

    def save(self, session: ConversationSession) -> None:
        """Store the latest session snapshot."""
        self._sessions[session.session_id] = session
