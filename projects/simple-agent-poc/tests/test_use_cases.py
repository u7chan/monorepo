"""Tests for RunAgentUseCase with streaming tool calling (ReAct loop)."""

from collections.abc import Iterator

from tests.helpers import (
    _batch_questions_args,
    _choice_questions_args,
    _over_limit_questions_args,
    _questions_args,
)

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
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import (
    LLMError,
    LLMStreamChunk,
    Message,
    SessionNotFoundError,
    SessionNotPausedError,
    ToolCall,
    ToolDefinition,
    Usage,
    ValidationError,
)


class FakeLLMClient:
    """Mock LLM client that returns streaming responses."""

    def __init__(self, *, rounds: list[dict]) -> None:
        self._rounds = rounds
        self._call_count = 0

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
        idx = self._call_count
        self._call_count += 1
        if idx < len(self._rounds):
            resp = self._rounds[idx]
            yield LLMStreamChunk(content_delta=resp["content"])
            if "tool_calls" in resp:
                for tc in resp["tool_calls"]:
                    yield LLMStreamChunk(
                        content_delta=None,
                        tool_call_delta={
                            "index": 0,
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["function"]["name"],
                                "arguments": tc["function"]["arguments"],
                            },
                        },
                    )
            yield LLMStreamChunk(content_delta=None, usage=resp["usage"])
        else:
            yield LLMStreamChunk(content_delta="Done.")
            yield LLMStreamChunk(
                content_delta=None,
                usage={
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            )


class FakeLLMClientFactory:
    def __init__(self, client: FakeLLMClient) -> None:
        self._client = client

    def __call__(self, agent_definition) -> FakeLLMClient:
        return self._client


def _concat_tool_call() -> list[ToolCall]:
    return [
        {
            "id": "call_001",
            "type": "function",
            "function": {
                "name": "concat",
                "arguments": '{"a": "hello", "b": "world"}',
            },
        }
    ]


def _usage() -> Usage:
    return {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}


def _agent_definitions_with_max_tool_rounds(
    max_tool_rounds: int,
) -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "test-model",
                    "system_prompt": "You are a helpful assistant.",
                    "tools": ["concat"],
                    "max_tool_rounds": max_tool_rounds,
                }
            }
        }
    )


def _ask_user_tool_call() -> list[ToolCall]:
    return [
        {
            "id": "call_ask_001",
            "type": "function",
            "function": {
                "name": "ask_user",
                "arguments": _questions_args(),
            },
        }
    ]


def _agent_definitions_with_ask_user() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "test-model",
                    "system_prompt": "You are a helpful assistant.",
                    "tools": ["ask_user"],
                },
            }
        }
    )


def _agent_definitions_with_ask_user_and_concat() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "test-model",
                    "system_prompt": "You are a helpful assistant.",
                    "tools": ["ask_user", "concat"],
                },
            }
        }
    )


def _setup_paused_session(
    store: InMemorySessionStore,
    session_id: str,
    tool_calls: list[ToolCall],
    *,
    round_idx: int = 0,
    user_message: str | None = None,
) -> None:
    session = ConversationSession.start(
        session_id=session_id,
        system_prompt="You are a helpful assistant.",
    )
    if user_message:
        session.append_user_message(user_message)
    session.append_assistant_message("", tool_calls=tool_calls)
    ask_user_tc = next(tc for tc in tool_calls if tc["function"]["name"] == "ask_user")
    session.pause_for_ask_user(ask_user_tc, round_idx=round_idx)
    store.save(session)


# ---------------------------------------------------------------------------
# Streaming basic tests
# ---------------------------------------------------------------------------


def test_execute_stream_without_tools(default_agent_def, tool_registry):
    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    events = list(use_case.execute_stream(RunAgentRequest(message="hello")))
    assert len(events) >= 2
    assert isinstance(events[0], ContentDelta)
    assert events[0].delta == "Done."
    assert isinstance(events[-1], StreamComplete)


def test_execute_stream_with_tool_call(default_agent_def, tool_registry):
    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": _concat_tool_call(),
            },
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    events = list(
        use_case.execute_stream(RunAgentRequest(message="concat hello world"))
    )

    tool_call_events = [e for e in events if isinstance(e, ToolCallEvent)]
    tool_result_events = [e for e in events if isinstance(e, ToolResultEvent)]

    assert len(tool_call_events) >= 1
    assert tool_call_events[0].name == "concat"
    assert "hello" in tool_call_events[0].arguments
    assert len(tool_result_events) >= 1
    assert tool_result_events[0].name == "concat"
    assert "helloworld" in tool_result_events[0].result


def test_execute_stream_uses_agent_max_tool_rounds(tool_registry):
    agent_definitions = _agent_definitions_with_max_tool_rounds(3)
    rounds = []
    for _ in range(3):
        rounds.append(
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": _concat_tool_call(),
            }
        )

    fake_llm = FakeLLMClient(rounds=rounds)
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=agent_definitions,
        tool_executor=tool_registry,
    )

    try:
        list(use_case.execute_stream(RunAgentRequest(message="loop")))
        assert False, "Expected LLMError"
    except LLMError:
        pass
    assert fake_llm._call_count == 3


def test_execute_stream_blank_message_rejected(default_agent_def, tool_registry):
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(FakeLLMClient(rounds=[])),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    try:
        list(use_case.execute_stream(RunAgentRequest(message="  ")))
        assert False, "Expected ValidationError"
    except ValidationError:
        pass


def test_continue_stream_uses_agent_max_tool_rounds(tool_registry):
    agent_definitions = _agent_definitions_with_max_tool_rounds(2)
    store = InMemorySessionStore()
    ask_user_tool_call: ToolCall = {
        "id": "call_ask_user",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _questions_args(question_text="Continue?"),
        },
    }
    _setup_paused_session(store, "paused-session", [ask_user_tool_call])

    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": _concat_tool_call(),
            }
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=agent_definitions,
        tool_executor=tool_registry,
    )

    try:
        list(
            use_case.continue_stream(
                ContinueRequest(session_id="paused-session", answers={"y": "yes"})
            )
        )
        assert False, "Expected LLMError"
    except LLMError:
        pass
    assert fake_llm._call_count == 1


def test_execute_stream_final_complete(default_agent_def, tool_registry):
    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    events = list(use_case.execute_stream(RunAgentRequest(message="hello")))
    assert isinstance(events[-1], StreamComplete)
    assert events[-1].session_id


# ---------------------------------------------------------------------------
# Streaming ask_user pause / resume
# ---------------------------------------------------------------------------


def test_execute_stream_paused_on_ask_user():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": _ask_user_tool_call(),
            },
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )
    events = list(use_case.execute_stream(RunAgentRequest(message="hello")))

    paused_events = [e for e in events if isinstance(e, SessionPaused)]
    assert len(paused_events) == 1
    assert paused_events[0].questions[0]["question"] == "What is your name?"
    assert paused_events[0].questions[0]["header"] == "Name"
    assert paused_events[0].questions[0]["type"] == "text"
    assert paused_events[0].call_id == "call_ask_001"


def test_continue_stream_resumes_and_completes():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_001",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(store, "paused-session", [ask_user_tc], user_message="hello")

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-session",
                answers={"What is your name?": "Alice"},
            )
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    assert any(isinstance(e, ContentDelta) and e.delta == "Done." for e in events)
    assert any(isinstance(e, StreamComplete) for e in events)


def test_continue_stream_does_not_offer_ask_user_after_answer():
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )
    from simple_agent_poc.adapters.tools.concat import (
        TOOL_DEFINITION as CONCAT_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.concat import execute as concat_execute
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry

    class CapturingLLMClient:
        def __init__(self) -> None:
            self.calls_tools: list[list[str]] = []
            self.calls_messages: list[list[Message]] = []

        def complete_stream(
            self,
            messages: list[Message],
            *,
            tools: list[ToolDefinition] | None = None,
        ) -> Iterator[LLMStreamChunk]:
            self.calls_messages.append(messages)
            self.calls_tools.append([tool["function"]["name"] for tool in tools or []])
            yield LLMStreamChunk(content_delta="Aliceさん、こんにちは。")
            yield LLMStreamChunk(
                content_delta=None,
                usage={
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)
    tool_executor.register(CONCAT_TOOL_DEF, concat_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_001",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(store, "paused-session", [ask_user_tc], user_message="hello")

    fake_llm = CapturingLLMClient()
    use_case = RunAgentUseCase(
        llm_client_factory=lambda _agent_definition: fake_llm,  # type: ignore[arg-type]
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user_and_concat(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-session",
                answers={"What is your name?": "Alice"},
            )
        )
    )

    assert any(isinstance(e, StreamComplete) for e in events)
    assert fake_llm.calls_tools == [["concat"]]
    assert fake_llm.calls_messages[0][-1]["role"] == "user"
    assert "Do not call ask_user again" in fake_llm.calls_messages[0][-1]["content"]
    assert "Alice" in fake_llm.calls_messages[0][-1]["content"]


def test_continue_stream_with_unknown_session_raises_error():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(FakeLLMClient(rounds=[])),
        session_store=InMemorySessionStore(),
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
    )

    try:
        list(
            use_case.continue_stream(
                ContinueRequest(session_id="missing", answers={"q": "no"})
            )
        )
        assert False, "Expected SessionNotFoundError"
    except SessionNotFoundError:
        pass


def test_continue_stream_with_non_paused_session_raises_error():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    store = InMemorySessionStore()
    session = ConversationSession.start(
        session_id="active-session",
        system_prompt="System prompt",
    )
    session.append_user_message("Hello")
    session.append_assistant_message("Hi")
    store.save(session)

    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(FakeLLMClient(rounds=[])),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
    )

    try:
        list(
            use_case.continue_stream(
                ContinueRequest(session_id="active-session", answers={"q": "no"})
            )
        )
        assert False, "Expected SessionNotPausedError"
    except SessionNotPausedError:
        pass


# ---------------------------------------------------------------------------
# Streaming choice / multi-question tests
# ---------------------------------------------------------------------------


def test_continue_stream_choice_number_to_label():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_stream",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _choice_questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(
        store, "paused-stream-choice", [ask_user_tc], user_message="hello"
    )

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-stream-choice",
                answers={"Which database?": "2"},
            )
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    stored = store.get("paused-stream-choice")
    assert stored is not None
    tool_msg = [m for m in stored.messages if m["role"] == "tool"][-1]
    content = tool_msg["content"]
    assert "--- ユーザーからの回答 ---" in content
    assert "Which database? → SQLite" in content
    assert "（選択肢から選択）" in content


def test_continue_stream_choice_multi_select():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_multi",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _choice_questions_args(multi_select=True),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(store, "paused-multi", [ask_user_tc], user_message="hello")

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-multi", answers={"Which database?": "2, 1"}
            )
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    stored = store.get("paused-multi")
    assert stored is not None
    tool_msg = [m for m in stored.messages if m["role"] == "tool"][-1]
    content = tool_msg["content"]
    assert "--- ユーザーからの回答 ---" in content
    assert "Which database? → SQLite, PostgreSQL" in content
    assert "（選択肢から選択）" in content


def test_continue_stream_choice_free_text_fallback():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_free",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _choice_questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(store, "paused-free", [ask_user_tc], user_message="hello")

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-free",
                answers={"Which database?": "MySQL"},
            )
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    stored = store.get("paused-free")
    assert stored is not None
    tool_msg = [m for m in stored.messages if m["role"] == "tool"][-1]
    content = tool_msg["content"]
    assert "--- ユーザーからの回答 ---" in content
    assert "Which database? → MySQL" in content
    assert "（選択肢から選択）" in content


def test_continue_stream_choice_single_select_comma_fallback():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    ask_user_tc: ToolCall = {
        "id": "call_ask_single_comma",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _choice_questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(
        store, "paused-single-comma", [ask_user_tc], user_message="hello"
    )

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    events = list(
        use_case.continue_stream(
            ContinueRequest(
                session_id="paused-single-comma",
                answers={"Which database?": "1, 2"},
            )
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    stored = store.get("paused-single-comma")
    assert stored is not None
    tool_msg = [m for m in stored.messages if m["role"] == "tool"][-1]
    content = tool_msg["content"]
    assert "--- ユーザーからの回答 ---" in content
    assert "Which database? → 1, 2" in content
    assert "（選択肢から選択）" in content


# ---------------------------------------------------------------------------
# Multi-question batch streaming tests
# ---------------------------------------------------------------------------


def test_execute_stream_multi_question_batch():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    batch_tc: list[ToolCall] = [
        {
            "id": "call_batch_001",
            "type": "function",
            "function": {
                "name": "ask_user",
                "arguments": _batch_questions_args(),
            },
        }
    ]

    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": batch_tc,
            },
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )
    events = list(use_case.execute_stream(RunAgentRequest(message="hello")))

    paused_events = [e for e in events if isinstance(e, SessionPaused)]
    assert len(paused_events) == 1
    assert len(paused_events[0].questions) == 3
    assert paused_events[0].questions[0]["question"] == "プロジェクト名は？"
    assert paused_events[0].questions[1]["question"] == "どのデータベースを使いますか？"
    assert paused_events[0].questions[2]["question"] == "どの言語を使いますか？"


def test_continue_stream_multi_question_batch():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    batch_tc: ToolCall = {
        "id": "call_batch_001",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": _batch_questions_args(),
        },
    }
    store = InMemorySessionStore()
    _setup_paused_session(store, "paused-batch", [batch_tc], user_message="hello")

    fake_llm = FakeLLMClient(rounds=[])
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=store,
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )

    answers = {
        "プロジェクト名は？": "my-app",
        "どのデータベースを使いますか？": "1",
        "どの言語を使いますか？": "TypeScript",
    }
    events = list(
        use_case.continue_stream(
            ContinueRequest(session_id="paused-batch", answers=answers)
        )
    )

    assert isinstance(events[0], ToolResultEvent)
    stored = store.get("paused-batch")
    assert stored is not None
    tool_msg = [m for m in stored.messages if m["role"] == "tool"][-1]
    content = tool_msg["content"]
    assert "プロジェクト名は？ → my-app" in content
    assert "どのデータベースを使いますか？ → PostgreSQL" in content
    assert "どの言語を使いますか？ → TypeScript" in content


def test_execute_stream_over_max_questions_raises_error():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    over_limit_tc: list[ToolCall] = [
        {
            "id": "call_over_001",
            "type": "function",
            "function": {
                "name": "ask_user",
                "arguments": _over_limit_questions_args(),
            },
        }
    ]

    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": over_limit_tc,
            },
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )
    try:
        list(use_case.execute_stream(RunAgentRequest(message="hello")))
        assert False, "Expected ValidationError"
    except ValidationError:
        pass


def test_execute_stream_empty_questions_raises_error():
    from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
    from simple_agent_poc.adapters.tools.ask_user import (
        TOOL_DEFINITION as ASK_USER_TOOL_DEF,
    )
    from simple_agent_poc.adapters.tools.ask_user import (
        execute as ask_user_execute,
    )

    tool_executor = BuiltinToolRegistry()
    tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

    empty_tc: list[ToolCall] = [
        {
            "id": "call_empty_001",
            "type": "function",
            "function": {
                "name": "ask_user",
                "arguments": '{"questions": []}',
            },
        }
    ]

    fake_llm = FakeLLMClient(
        rounds=[
            {
                "content": "",
                "usage": _usage(),
                "model": "fake",
                "response_time": 0.1,
                "tool_calls": empty_tc,
            },
        ]
    )
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=_agent_definitions_with_ask_user(),
        tool_executor=tool_executor,
        is_api_context=True,
    )
    try:
        list(use_case.execute_stream(RunAgentRequest(message="hello")))
        assert False, "Expected ValidationError"
    except ValidationError:
        pass
