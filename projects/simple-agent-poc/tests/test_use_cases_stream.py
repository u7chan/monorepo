"""Tests for streaming use case."""

from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import (
    ContentDelta,
    RunAgentRequest,
    StreamComplete,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import (
    LLMResponse,
    LLMStreamChunk,
    Message,
    SessionNotFoundError,
    Usage,
    ValidationError,
)


class StreamingStubLLMClient:
    """Stub LLM client for streaming tests."""

    def __init__(self, chunks: list[LLMStreamChunk]) -> None:
        self.chunks = chunks
        self.calls: list[list[Message]] = []

    def complete(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> LLMResponse:
        raise NotImplementedError

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> Iterator[LLMStreamChunk]:
        self.calls.append(list(messages))
        yield from self.chunks


def build_registry(*, stream: bool = False) -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                    "stream": stream,
                },
                "researcher": {
                    "model": "research-model",
                    "system_prompt": "Research prompt",
                    "stream": stream,
                },
            }
        }
    )


class TestExecuteStream:
    """Tests for execute_stream use case."""

    def test_execute_stream_yields_content_deltas_and_complete(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Hello"},
            {"content_delta": ", world!"},
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        # Last element is StreamComplete, preceded by ContentDelta events
        assert len(events) == 3
        assert events[0] == ContentDelta(delta="Hello")
        assert events[1] == ContentDelta(delta=", world!")
        complete = events[2]
        assert isinstance(complete, StreamComplete)
        assert complete.model == "default-model"

    def test_execute_stream_saves_session_on_success(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Hello"},
            {"content_delta": ", world!"},
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        complete = events[-1]
        assert isinstance(complete, StreamComplete)
        session = store.get(complete.session_id)
        assert session is not None
        assert session.messages[-1] == {
            "role": "assistant",
            "content": "Hello, world!",
        }

    def test_execute_stream_saves_partial_text_on_error(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Hello"},
            {"content_delta": ", "},
        ]

        class ErrorStreamingClient:
            def __init__(self) -> None:
                self.chunks = chunks

            def complete(
                self,
                messages: list[Message],
                *,
                tools=None,
            ) -> LLMResponse:
                raise NotImplementedError

            def complete_stream(  # type: ignore[return-type]
                self,
                messages: list[Message],
                *,
                tools=None,
            ) -> Iterator[LLMStreamChunk]:
                yield from self.chunks
                raise RuntimeError("Connection lost")

        llm_client = ErrorStreamingClient()
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        request = RunAgentRequest(message="Hello")
        with pytest.raises(RuntimeError, match="Connection lost"):
            list(use_case.execute_stream(request))

        sessions = list(store._sessions.values())
        assert len(sessions) == 1
        session = sessions[0]
        assert session.messages[-1] == {
            "role": "assistant",
            "content": "Hello, \n\n[stream interrupted]",
        }

    def test_execute_stream_saves_interrupted_marker_on_empty_error(self) -> None:
        class ErrorStreamingClient:
            def complete(
                self,
                messages: list[Message],
                *,
                tools=None,
            ) -> LLMResponse:
                raise NotImplementedError

            def complete_stream(  # type: ignore[return-type]
                self,
                messages: list[Message],
                *,
                tools=None,
            ) -> Iterator[LLMStreamChunk]:
                raise RuntimeError("Connection lost")
                yield  # pragma: no cover

        llm_client = ErrorStreamingClient()
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        request = RunAgentRequest(message="Hello")
        with pytest.raises(RuntimeError, match="Connection lost"):
            list(use_case.execute_stream(request))

        sessions = list(store._sessions.values())
        assert len(sessions) == 1
        session = sessions[0]
        assert session.messages[-1] == {
            "role": "assistant",
            "content": "[stream interrupted]",
        }

    def test_execute_stream_reuses_existing_session(self) -> None:
        first_client = StreamingStubLLMClient(chunks=[{"content_delta": "First"}])
        second_client = StreamingStubLLMClient(chunks=[{"content_delta": "Second"}])
        store = InMemorySessionStore()
        first_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=first_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )
        second_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=second_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        first_events = list(
            first_use_case.execute_stream(RunAgentRequest(message="Hello"))
        )
        first_complete = first_events[-1]
        assert isinstance(first_complete, StreamComplete)

        _ = list(
            second_use_case.execute_stream(
                RunAgentRequest(
                    message="Again",
                    session_id=first_complete.session_id,
                )
            )
        )

        assert second_client.calls[0] == [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "First"},
            {"role": "user", "content": "Again"},
        ]

    def test_execute_stream_uses_requested_agent_definition(self) -> None:
        llm_client = StreamingStubLLMClient(
            chunks=[{"content_delta": "Research reply"}]
        )
        llm_client_factory = MagicMock(return_value=llm_client)
        use_case = RunAgentUseCase(
            llm_client_factory=llm_client_factory,
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        list(
            use_case.execute_stream(
                RunAgentRequest(message="Hello", agent_id="researcher")
            )
        )

        llm_client_factory.assert_called_once()
        assert llm_client_factory.call_args.args[0].agent_id == "researcher"

    def test_execute_stream_rejects_blank_message(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        with pytest.raises(ValidationError, match="message must not be blank"):
            list(use_case.execute_stream(RunAgentRequest(message="   ")))

    def test_execute_stream_rejects_unknown_session(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        with pytest.raises(SessionNotFoundError, match="Session not found"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(message="Hello", session_id="missing-session")
                )
            )

    def test_execute_stream_rejects_agent_change(self) -> None:
        llm_client = StreamingStubLLMClient(chunks=[{"content_delta": "First"}])
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry(stream=True),
        )

        first_events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))
        first_complete = first_events[-1]
        assert isinstance(first_complete, StreamComplete)

        with pytest.raises(ValidationError, match="agent_id cannot be changed"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(
                        message="Again",
                        session_id=first_complete.session_id,
                        agent_id="researcher",
                    )
                )
            )

    def test_execute_stream_rejects_unknown_agent_id(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        with pytest.raises(ValidationError, match="Unknown agent_id: missing"):
            list(
                use_case.execute_stream(
                    RunAgentRequest(message="Hello", agent_id="missing")
                )
            )

    def test_execute_stream_captures_usage_from_last_chunk(self) -> None:
        usage_from_stream: Usage = {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        }
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Hello"},
            {"content_delta": None, "usage": usage_from_stream},
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        complete = events[-1]
        assert isinstance(complete, StreamComplete)
        assert complete.usage == usage_from_stream

    def test_execute_stream_usage_is_none_when_not_provided(self) -> None:
        chunks: list[LLMStreamChunk] = [{"content_delta": "Hello"}]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry(stream=True),
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        complete = events[-1]
        assert isinstance(complete, StreamComplete)
        assert complete.usage is None
