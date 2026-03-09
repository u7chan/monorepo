"""Tests for session entities and stores."""

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.core.session import ConversationSession


class TestConversationSession:
    """Tests for ConversationSession."""

    def test_start_initializes_system_message(self) -> None:
        session = ConversationSession.start(
            session_id="session-1",
            system_prompt="System prompt",
        )

        assert session.session_id == "session-1"
        assert session.messages == [{"role": "system", "content": "System prompt"}]

    def test_appends_messages_in_order(self) -> None:
        session = ConversationSession.start(
            session_id="session-1",
            system_prompt="System prompt",
        )

        session.append_user_message("Hello")
        session.append_assistant_message("Hi")

        assert session.messages == [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
        ]


class TestInMemorySessionStore:
    """Tests for the in-memory session store."""

    def test_save_and_get(self) -> None:
        store = InMemorySessionStore()
        session = ConversationSession.start(
            session_id="session-1",
            system_prompt="System prompt",
        )

        store.save(session)

        assert store.get("session-1") is session

    def test_get_returns_none_for_unknown_session(self) -> None:
        store = InMemorySessionStore()

        assert store.get("missing") is None
