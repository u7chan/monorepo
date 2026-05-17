"""Tests for RunAgentUseCase with tool calling (ReAct loop)."""

from collections.abc import Iterator

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import (
    ContentDelta,
    ContinueRequest,
    RunAgentRequest,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import (
    LLMError,
    LLMResponse,
    LLMStreamChunk,
    Message,
    ToolCall,
    ToolDefinition,
    Usage,
    ValidationError,
)


class FakeLLMClient:
    """Mock LLM client that returns tool calls, then final response."""

    def __init__(self, *, rounds: list[LLMResponse]) -> None:
        self._rounds = rounds
        self._call_count = 0

    def complete(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> LLMResponse:
        idx = self._call_count
        self._call_count += 1
        if idx < len(self._rounds):
            return self._rounds[idx]
        return {
            "content": "Done.",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "model": "fake",
            "response_time": 0.1,
        }

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


def test_execute_yields_final_response_without_tools(default_agent_def, tool_registry):
    """Without tools, the agent returns a normal text response."""
    fake_llm = FakeLLMClient(rounds=[])

    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(fake_llm),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    response = use_case.execute(RunAgentRequest(message="hello"))
    assert response.message == "Done."
    assert response.session_id


def test_execute_with_tool_call(default_agent_def, tool_registry):
    """When the LLM returns a tool call, execute the tool and continue."""
    fake_llm = FakeLLMClient(
        rounds=[
            {  # Round 1: tool call
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
    response = use_case.execute(RunAgentRequest(message="concat hello world"))
    assert "helloworld" in response.message.lower() or "Done" in response.message
    assert response.session_id


def test_execute_exceeds_max_tool_rounds(default_agent_def, tool_registry):
    """After max_tool_rounds (default 5), an LLMError is raised."""
    rounds = []
    for _ in range(5):
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
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    try:
        use_case.execute(RunAgentRequest(message="loop"))
        assert False, "Expected LLMError"
    except LLMError:
        pass


def test_execute_uses_agent_max_tool_rounds(tool_registry):
    """The ReAct loop stops at the agent's configured max_tool_rounds."""
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
        use_case.execute(RunAgentRequest(message="loop"))
        assert False, "Expected LLMError"
    except LLMError:
        pass
    assert fake_llm._call_count == 3


def test_execute_blank_message_rejected(default_agent_def, tool_registry):
    use_case = RunAgentUseCase(
        llm_client_factory=FakeLLMClientFactory(FakeLLMClient(rounds=[])),
        session_store=InMemorySessionStore(),
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
    )
    try:
        use_case.execute(RunAgentRequest(message="  "))
        assert False, "Expected ValidationError"
    except ValidationError:
        pass


def test_execute_stream_without_tools(default_agent_def, tool_registry):
    """Streaming works normally when no tools are called."""
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
    """Streaming with a tool call yields ToolCallEvent and ToolResultEvent."""
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
    """The streaming ReAct loop stops at the configured max_tool_rounds."""
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


def test_continue_stream_uses_agent_max_tool_rounds(tool_registry):
    """The resumed streaming ReAct loop stops at the remaining max_tool_rounds."""
    agent_definitions = _agent_definitions_with_max_tool_rounds(2)
    store = InMemorySessionStore()
    ask_user_tool_call: ToolCall = {
        "id": "call_ask_user",
        "type": "function",
        "function": {
            "name": "ask_user",
            "arguments": '{"question": "Continue?"}',
        },
    }
    session = ConversationSession.start(
        session_id="paused-session",
        system_prompt="You are a helpful assistant.",
    )
    session.append_assistant_message("", tool_calls=[ask_user_tool_call])
    session.pause_for_ask_user(ask_user_tool_call, round_idx=0)
    store.save(session)

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
                ContinueRequest(session_id="paused-session", answer="yes")
            )
        )
        assert False, "Expected LLMError"
    except LLMError:
        pass
    assert fake_llm._call_count == 1


def test_execute_stream_final_complete(default_agent_def, tool_registry):
    """The last event in a stream should be StreamComplete."""
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
