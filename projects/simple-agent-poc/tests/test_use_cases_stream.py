"""Tests for streaming use case."""

from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest

from tests.helpers import _batch_questions_args, _questions_args

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import (
    ContentDelta,
    ContinueRequest,
    RunAgentRequest,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import (
    LLMResponse,
    LLMStreamChunk,
    Message,
    SessionNotFoundError,
    SessionNotPausedError,
    Usage,
    ValidationError,
)
from simple_agent_poc.adapters.tools.concat import TOOL_DEFINITION as CONCAT_TOOL_DEF
from simple_agent_poc.adapters.tools.concat import execute as concat_execute
from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
from simple_agent_poc.adapters.tools.ask_user import (
    TOOL_DEFINITION as ASK_USER_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.ask_user import (
    execute as ask_user_execute,
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


def build_registry_with_ask_user(*, stream: bool = False) -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                    "stream": stream,
                    "tools": ["ask_user"],
                },
            }
        }
    )


def build_tool_executor_with_ask_user() -> BuiltinToolRegistry:
    registry = BuiltinToolRegistry()
    registry.register(ASK_USER_TOOL_DEF, ask_user_execute)
    return registry


def build_registry_with_ask_user_and_concat() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                    "stream": True,
                    "tools": ["ask_user", "concat"],
                },
            }
        }
    )


def build_tool_executor_with_ask_user_and_concat() -> BuiltinToolRegistry:
    registry = build_tool_executor_with_ask_user()
    registry.register(CONCAT_TOOL_DEF, concat_execute)
    return registry


class TestExecuteStreamPause:
    """Tests for execute_stream pause on ask_user in API mode."""

    def test_execute_stream_pauses_on_ask_user_in_api_mode(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(
                            question_text="What is your name?"
                        ),
                    },
                },
            },
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        assert len(events) == 2
        assert isinstance(events[0], ToolCallEvent)
        assert events[0].name == "ask_user"
        assert isinstance(events[1], SessionPaused)
        assert events[1].questions[0]["question"] == "What is your name?"

        session = store.get(events[1].session_id)
        assert session is not None
        assert session.is_paused is True
        assert session.pending_tool_call is not None
        assert session.pending_tool_call["function"]["name"] == "ask_user"

    def test_execute_stream_executes_ask_user_in_non_api_mode(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="What?"),
                    },
                },
            },
        ]
        second_chunks: list[LLMStreamChunk] = [
            {"content_delta": "The answer is provided."},
        ]
        store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()

        call_count = 0
        chunks_per_call = [first_chunks, second_chunks]

        class MultiCallStubClient:
            def complete(self, messages, *, tools=None):
                raise NotImplementedError

            def complete_stream(self, messages, *, tools=None):
                nonlocal call_count
                chunks = chunks_per_call[min(call_count, len(chunks_per_call) - 1)]
                call_count += 1
                yield from chunks

        use_case = RunAgentUseCase(
            llm_client_factory=lambda _agent_definition: MultiCallStubClient(),  # type: ignore[arg-type]
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=False,
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        assert isinstance(events[0], ToolCallEvent)
        assert events[0].name == "ask_user"
        result_events = [e for e in events if isinstance(e, ToolResultEvent)]
        assert len(result_events) == 1
        assert result_events[0].name == "ask_user"
        paused_events = [e for e in events if isinstance(e, SessionPaused)]
        assert len(paused_events) == 0
        assert isinstance(events[-1], StreamComplete)

    def test_execute_stream_removes_ask_user_after_cli_answer(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="What?"),
                    },
                },
            },
        ]
        second_chunks: list[LLMStreamChunk] = [
            {"content_delta": "The answer is provided."},
        ]
        chunks_per_call = [first_chunks, second_chunks]

        class CapturingClient:
            def __init__(self) -> None:
                self.call_count = 0
                self.calls_tools: list[list[str]] = []
                self.calls_messages: list[list[Message]] = []

            def complete(self, messages, *, tools=None):
                raise NotImplementedError

            def complete_stream(self, messages, *, tools=None):
                self.calls_messages.append(messages)
                self.calls_tools.append(
                    [tool["function"]["name"] for tool in tools or []]
                )
                chunks = chunks_per_call[min(self.call_count, len(chunks_per_call) - 1)]
                self.call_count += 1
                yield from chunks

        llm_client = CapturingClient()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry_with_ask_user_and_concat(),
            tool_executor=build_tool_executor_with_ask_user_and_concat(),
            is_api_context=False,
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        assert isinstance(events[-1], StreamComplete)
        assert llm_client.calls_tools == [["ask_user", "concat"], ["concat"]]
        assert llm_client.calls_messages[1][-1]["role"] == "user"
        assert (
            "Do not call ask_user again" in llm_client.calls_messages[1][-1]["content"]
        )
        assert "ユーザーからの回答" in llm_client.calls_messages[1][-1]["content"]


class TestContinueStream:
    """Tests for continue_stream."""

    def test_continue_stream_resumes_paused_session(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="Your name?"),
                    },
                },
            },
        ]
        second_chunks: list[LLMStreamChunk] = [
            {"content_delta": "Your name is Alice."},
        ]
        store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()

        first_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(
                return_value=StreamingStubLLMClient(chunks=first_chunks)
            ),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        first_events = list(
            first_use_case.execute_stream(RunAgentRequest(message="Hello"))
        )
        paused = first_events[-1]
        assert isinstance(paused, SessionPaused)

        second_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(
                return_value=StreamingStubLLMClient(chunks=second_chunks)
            ),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        continue_events = list(
            second_use_case.continue_stream(
                ContinueRequest(
                    session_id=paused.session_id, answers={"Your name?": "Alice"}
                )
            )
        )

        result_events = [e for e in continue_events if isinstance(e, ToolResultEvent)]
        assert len(result_events) == 1
        assert result_events[0].name == "ask_user"
        assert result_events[0].call_id == paused.call_id

        content_events = [e for e in continue_events if isinstance(e, ContentDelta)]
        assert len(content_events) == 1

        assert isinstance(continue_events[-1], StreamComplete)

        session = store.get(paused.session_id)
        assert session is not None
        assert session.is_paused is False

    def test_continue_stream_with_unknown_session_raises_error(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(),
            session_store=InMemorySessionStore(),
            agent_definitions=build_registry_with_ask_user(stream=True),
            is_api_context=True,
        )

        with pytest.raises(SessionNotFoundError, match="Session not found"):
            list(
                use_case.continue_stream(
                    ContinueRequest(session_id="missing", answers={"q": "no"})
                )
            )

    def test_continue_stream_with_non_paused_session_raises_error(self) -> None:
        store = InMemorySessionStore()
        from simple_agent_poc.core.session import ConversationSession

        session = ConversationSession.start(
            session_id="active-session",
            system_prompt="System prompt",
        )
        session.append_user_message("Hello")
        session.append_assistant_message("Hi")
        store.save(session)

        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            is_api_context=True,
        )

        with pytest.raises(SessionNotPausedError, match="not in a paused state"):
            list(
                use_case.continue_stream(
                    ContinueRequest(session_id="active-session", answers={"q": "no"})
                )
            )


class TestExecuteStreamBatch:
    """Phase 3: multi-question batch tests for streaming."""

    def test_execute_stream_pauses_with_batch_questions_in_api_mode(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_batch_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _batch_questions_args(),
                    },
                },
            },
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        events = list(use_case.execute_stream(RunAgentRequest(message="Hello")))

        assert len(events) == 2
        assert isinstance(events[0], ToolCallEvent)
        assert events[0].name == "ask_user"
        assert isinstance(events[1], SessionPaused)
        assert len(events[1].questions) == 3
        assert events[1].questions[0]["question"] == "プロジェクト名は？"
        assert events[1].questions[1]["type"] == "choice"

    def test_continue_stream_resumes_batch(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_batch_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _batch_questions_args(),
                    },
                },
            },
        ]
        second_chunks: list[LLMStreamChunk] = [
            {"content_delta": "プロジェクト my-app を作成しました。"},
        ]
        store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()

        first_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(
                return_value=StreamingStubLLMClient(chunks=first_chunks)
            ),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        first_events = list(
            first_use_case.execute_stream(RunAgentRequest(message="プロジェクト作成"))
        )
        paused = first_events[-1]
        assert isinstance(paused, SessionPaused)

        second_use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(
                return_value=StreamingStubLLMClient(chunks=second_chunks)
            ),
            session_store=store,
            agent_definitions=build_registry_with_ask_user(stream=True),
            tool_executor=tool_executor,
            is_api_context=True,
        )

        answers = {
            "プロジェクト名は？": "my-app",
            "どのデータベースを使いますか？": "1",
            "どの言語を使いますか？": "TypeScript",
        }
        continue_events = list(
            second_use_case.continue_stream(
                ContinueRequest(session_id=paused.session_id, answers=answers)
            )
        )

        result_events = [e for e in continue_events if isinstance(e, ToolResultEvent)]
        assert len(result_events) == 1
        assert result_events[0].name == "ask_user"
        assert "my-app" in result_events[0].result
        assert "PostgreSQL" in result_events[0].result

        assert isinstance(continue_events[-1], StreamComplete)
