"""Tests for application DTOs and use cases."""

from unittest.mock import MagicMock

import pytest

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import RunAgentRequest, StreamComplete
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import (
    LLMStreamChunk,
    SessionNotFoundError,
    ValidationError,
)


class TestRunAgentRequest:
    """Tests for request DTO."""

    def test_defaults_session_id_to_none(self) -> None:
        request = RunAgentRequest(message="Hello")

        assert request.message == "Hello"
        assert request.session_id is None
        assert request.agent_id == "default"


class TestRunAgentUseCase:
    """Tests for the reusable agent execution path."""

    def build_registry(self) -> AgentDefinitionRegistry:
        return AgentDefinitionRegistry.from_mapping(
            {
                "agents": {
                    "default": {
                        "model": "default-model",
                        "system_prompt": "System prompt",
                    },
                    "researcher": {
                        "model": "research-model",
                        "system_prompt": "Research prompt",
                        "temperature": 0.1,
                        "tools": [],
                    },
                }
            }
        )

    def _streaming_llm_client(self, content: str = "Hello, user!"):
        llm_client = MagicMock()

        def _stream(*args, **kwargs):
            yield LLMStreamChunk(content_delta=content)
            yield LLMStreamChunk(
                content_delta=None,
                usage={
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            )

        llm_client.complete_stream = MagicMock(side_effect=_stream)
        return llm_client

    def test_execute_stream_creates_new_session_and_saves_it(self) -> None:
        llm_client = self._streaming_llm_client()
        store = InMemorySessionStore()
        llm_client_factory = MagicMock(return_value=llm_client)
        use_case = RunAgentUseCase(
            llm_client_factory=llm_client_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        assert isinstance(events[-1], StreamComplete)
        assert events[-1].session_id
        session_id = events[-1].session_id

        llm_client.complete_stream.assert_called_once_with(
            [
                {"role": "system", "content": "System prompt"},
                {"role": "user", "content": "Hello"},
            ],
            tools=None,
        )
        llm_client_factory.assert_called_once()
        assert llm_client_factory.call_args.args[0].agent_id == "default"
        stored_session = store.get(session_id)
        assert stored_session is not None
        assert stored_session.agent_id == "default"

    def test_execute_stream_uses_requested_agent_definition(self) -> None:
        llm_client = self._streaming_llm_client("Research reply")
        llm_client_factory = MagicMock(return_value=llm_client)
        use_case = RunAgentUseCase(
            llm_client_factory=llm_client_factory,
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        events = list(
            use_case.execute_stream(
                RunAgentRequest(message="Hello", agent_id="researcher")
            )
        )

        assert isinstance(events[-1], StreamComplete)
        assert events[-1].model == "research-model"
        llm_client_factory.assert_called_once()
        assert llm_client_factory.call_args.args[0].agent_id == "researcher"
        llm_client.complete_stream.assert_called_once_with(
            [
                {"role": "system", "content": "Research prompt"},
                {"role": "user", "content": "Hello"},
            ],
            tools=None,
        )

    def test_execute_stream_reuses_existing_session(self) -> None:
        first_client = self._streaming_llm_client("First reply")
        second_client = self._streaming_llm_client("Second reply")
        store = InMemorySessionStore()
        first_factory = MagicMock(return_value=first_client)
        second_factory = MagicMock(return_value=second_client)
        first_use_case = RunAgentUseCase(
            llm_client_factory=first_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )
        second_use_case = RunAgentUseCase(
            llm_client_factory=second_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        first_events = list(
            first_use_case.execute_stream(RunAgentRequest(message="Hello"))
        )
        assert isinstance(first_events[-1], StreamComplete)
        first_session_id = first_events[-1].session_id

        second_events = list(
            second_use_case.execute_stream(
                RunAgentRequest(message="Again", session_id=first_session_id)
            )
        )

        assert isinstance(second_events[-1], StreamComplete)
        assert second_events[-1].session_id == first_session_id

    def test_execute_stream_rejects_agent_change_for_existing_session(
        self,
    ) -> None:
        llm_client = self._streaming_llm_client()
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))
        assert isinstance(events[-1], StreamComplete)
        session_id = events[-1].session_id

        with pytest.raises(ValidationError, match="agent_id cannot be changed"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(
                        message="Again",
                        session_id=session_id,
                        agent_id="researcher",
                    )
                )
            )

    def test_execute_stream_rejects_unknown_session(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(SessionNotFoundError, match="Session not found"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(message="Hello", session_id="missing-session")
                )
            )

    def test_execute_stream_rejects_blank_message(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(ValidationError, match="message must not be blank"):
            list(use_case.execute_stream(RunAgentRequest(message="   ")))

    def test_execute_stream_rejects_unknown_agent_id(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(ValidationError, match="Unknown agent_id: missing"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(message="Hello", agent_id="missing")
                )
            )
