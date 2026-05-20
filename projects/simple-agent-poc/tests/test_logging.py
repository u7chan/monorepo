"""Tests for structured JSONL debug logging."""

import json
import logging
import tempfile
from collections.abc import Generator
from pathlib import Path
from typing import cast

import pytest

import simple_agent_poc.observability as obs
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import (
    ContinueRequest,
    RunAgentPaused,
    RunAgentRequest,
    RunAgentResponse,
    StreamComplete,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.types import (
    LLMError,
    LLMResponse,
    LLMStreamChunk,
    Message,
    SessionNotFoundError,
    ToolCall,
    ToolDefinition,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_observability_state() -> None:
    """Reset global state of the observability module between tests."""
    obs._enabled = True
    obs._payload_policy = "summary"
    obs._max_field_chars = 500
    obs._initialized = False
    obs._logger.handlers.clear()
    obs._logger.setLevel(logging.NOTSET)
    obs._run_id.set("")
    obs._session_id.set("")
    obs._agent_id.set("")
    obs._mode.set("")


def _read_jsonl(path: Path) -> list[dict]:
    """Read JSONL file and return list of parsed dicts."""
    events: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


@pytest.fixture
def temp_log_path() -> Generator[Path]:
    with tempfile.TemporaryDirectory() as td:
        yield Path(td) / "test-events.jsonl"


# ---------------------------------------------------------------------------
# Payload summarisation
# ---------------------------------------------------------------------------


def test_summarize_payload_none():
    result = obs.summarize_payload(None)
    assert result == {"type": "null", "length": 0}


def test_summarize_payload_summary_str(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "summary")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_MAX_FIELD_CHARS", "500")
    obs.configure_logging()

    text = "hello " * 200
    result = obs.summarize_payload(text)
    assert result["type"] == "str"
    assert result["length"] == len(text)
    assert "sha256" in result
    assert "preview" in result
    assert len(cast(str, result["preview"])) == 500


def test_summarize_payload_metadata_str(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "metadata")
    obs.configure_logging()

    text = "secret content"
    result = obs.summarize_payload(text)
    assert result["type"] == "str"
    assert result["length"] == len(text)
    assert "sha256" in result
    assert "preview" not in result
    assert "content" not in result


def test_summarize_payload_full_str(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "full")
    obs.configure_logging()

    text = "full content here"
    result = obs.summarize_payload(text)
    assert result["type"] == "str"
    assert result["length"] == len(text)
    assert result["content"] == text


def test_summarize_payload_summary_dict(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "summary")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_MAX_FIELD_CHARS", "10")
    obs.configure_logging()

    data = {"a": 1, "b": "hello world, this is a long value"}
    result = obs.summarize_payload(data)
    assert result["type"] == "dict"
    assert "sha256" in result
    assert "preview" in result
    assert len(cast(str, result["preview"])) == 10


# ---------------------------------------------------------------------------
# configure_logging
# ---------------------------------------------------------------------------


def test_configure_logging_enabled(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))

    obs.configure_logging()

    assert obs._enabled is True
    assert obs._initialized is True
    assert obs._logger.handlers
    assert temp_log_path.parent.exists()


def test_configure_logging_disabled(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))

    obs.configure_logging()

    assert obs._enabled is False
    assert obs._initialized is True
    assert not obs._logger.handlers


def test_configure_logging_idempotent(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))

    obs.configure_logging()
    obs.configure_logging()

    assert len(obs._logger.handlers) == 1


# ---------------------------------------------------------------------------
# log_event + JSONL output
# ---------------------------------------------------------------------------


def test_log_event_writes_jsonl(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.bind_log_context(
        run_id="run-001", session_id="sess-001", agent_id="default", mode="cli"
    )
    obs.log_event("agent.run.start", round=0, model="test-model")

    events = _read_jsonl(temp_log_path)
    assert len(events) == 1
    e = events[0]
    assert e["event"] == "agent.run.start"
    assert e["run_id"] == "run-001"
    assert e["session_id"] == "sess-001"
    assert e["agent_id"] == "default"
    assert e["mode"] == "cli"
    assert e["round"] == 0
    assert e["model"] == "test-model"
    assert e["level"] == "INFO"
    assert "timestamp" in e


def test_log_event_disabled_does_not_write(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "false")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.log_event("agent.run.start", round=0)

    assert not temp_log_path.exists()


def test_log_event_includes_context(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.bind_log_context(run_id="r1", session_id="s1", agent_id="a1", mode="cli")
    obs.log_event("test.event", custom_field="value")

    events = _read_jsonl(temp_log_path)
    assert events[0]["custom_field"] == "value"
    assert events[0]["run_id"] == "r1"


def test_bind_log_context_partial_update(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.bind_log_context(run_id="r1")
    obs.log_event("test.one")
    obs.bind_log_context(session_id="s1")
    obs.log_event("test.two")

    events = _read_jsonl(temp_log_path)
    assert events[0]["run_id"] == "r1"
    assert events[0]["session_id"] is None
    assert events[1]["run_id"] == "r1"
    assert events[1]["session_id"] == "s1"


# ---------------------------------------------------------------------------
# Payload policy env var
# ---------------------------------------------------------------------------


def test_payload_policy_from_env(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "full")
    obs.configure_logging()

    assert obs._payload_policy == "full"


def test_max_field_chars_from_env(monkeypatch, temp_log_path):
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_MAX_FIELD_CHARS", "200")
    obs.configure_logging()

    assert obs._max_field_chars == 200


# ---------------------------------------------------------------------------
# Integration: RunAgentUseCase emits events (sync)
# ---------------------------------------------------------------------------


def _make_llm_response(
    content: str = "Hello!",
    tool_calls: list | None = None,
) -> LLMResponse:
    return LLMResponse(
        content=content,
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        model="test-model",
        response_time=0.05,
        tool_calls=tool_calls or [],
    )


class _RecordingLLMClient:
    """LLM client stub that returns predefined responses."""

    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = responses
        self._idx = 0

    def complete(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> LLMResponse:
        if self._idx < len(self._responses):
            resp = self._responses[self._idx]
            self._idx += 1
            return resp
        return _make_llm_response("Default response.")

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ):
        if self._idx < len(self._responses):
            resp = self._responses[self._idx]
            self._idx += 1
            yield LLMStreamChunk(content_delta=resp["content"])
            if resp.get("tool_calls"):
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
            yield LLMStreamChunk(content_delta=None, usage=resp.get("usage"))
        else:
            yield LLMStreamChunk(content_delta="Default response.")
            yield LLMStreamChunk(
                content_delta=None,
                usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            )


@pytest.fixture
def logging_use_case(monkeypatch, temp_log_path, default_agent_def, tool_registry):
    """Create a RunAgentUseCase wired with JSONL log file."""
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    monkeypatch.setenv("SIMPLE_AGENT_LOG_PAYLOADS", "summary")
    obs.configure_logging()

    store = InMemorySessionStore()

    def make_use_case(llm_client):
        return RunAgentUseCase(
            llm_client_factory=lambda _: llm_client,
            session_store=store,
            agent_definitions=default_agent_def,
            tool_executor=tool_registry,
            is_api_context=False,
        )

    return make_use_case


def test_sync_run_emits_core_events(logging_use_case, temp_log_path, default_agent_def):
    """A minimal sync run emits agent.run.start, session.created, react.round.*, agent.run.end."""
    llm_client = _RecordingLLMClient([_make_llm_response(content="Hi there.")])
    use_case = logging_use_case(llm_client)

    result = use_case.execute(RunAgentRequest(message="Hello", agent_id="default"))

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]

    assert "agent.run.start" in event_names
    assert "session.created" in event_names
    assert "react.round.start" in event_names
    assert "react.round.end" in event_names
    assert "agent.run.end" in event_names
    assert "session.saved" in event_names

    assert isinstance(result, RunAgentResponse)
    assert result.message == "Hi there."


def test_sync_run_with_tool_calls(logging_use_case, temp_log_path, default_agent_def):
    """Tool calls produce tool.call.start, tool.call.end events."""
    tool_response = _make_llm_response(
        content="Processing...",
        tool_calls=[
            ToolCall(
                id="call_t1",
                type="function",
                function={"name": "concat", "arguments": '{"a":"x","b":"y"}'},
            )
        ],
    )
    final_response = _make_llm_response(content="Result: xy")

    llm_client = _RecordingLLMClient([tool_response, final_response])
    use_case = logging_use_case(llm_client)

    use_case.execute(RunAgentRequest(message="concat x y", agent_id="default"))

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]

    assert "tool.call.start" in event_names
    assert "tool.call.end" in event_names

    tool_end = next(e for e in events if e["event"] == "tool.call.end")
    assert tool_end["tool_call_id"] == "call_t1"
    assert tool_end["tool_name"] == "concat"
    assert "payload" in tool_end


def test_sync_run_ask_user_pause(logging_use_case, temp_log_path, default_agent_def):
    """ask_user triggers ask_user.pause event."""
    ask_user_response = _make_llm_response(
        content="Please confirm:",
        tool_calls=[
            ToolCall(
                id="call_ask",
                type="function",
                function={
                    "name": "ask_user",
                    "arguments": json.dumps(
                        {"questions": [{"question": "OK?", "type": "text"}]},
                        ensure_ascii=False,
                    ),
                },
            )
        ],
    )

    llm_client = _RecordingLLMClient([ask_user_response])
    use_case = logging_use_case(llm_client)

    result = use_case.execute(
        RunAgentRequest(message="Should I proceed?", agent_id="default")
    )

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]

    assert "ask_user.pause" in event_names
    assert isinstance(result, RunAgentPaused)
    pause_event = next(e for e in events if e["event"] == "ask_user.pause")
    assert pause_event["tool_call_id"] == "call_ask"


def test_sync_run_ask_user_resume(
    logging_use_case, temp_log_path, default_agent_def, tool_registry
):
    """Resume after ask_user emits ask_user.resume and ask_user.answered."""
    ask_user_response = _make_llm_response(
        content="Please confirm:",
        tool_calls=[
            ToolCall(
                id="call_ask",
                type="function",
                function={
                    "name": "ask_user",
                    "arguments": json.dumps(
                        {"questions": [{"question": "OK?", "type": "text"}]},
                        ensure_ascii=False,
                    ),
                },
            )
        ],
    )
    final_response = _make_llm_response(content="Confirmed: Yes")

    store = InMemorySessionStore()
    llm_client = _RecordingLLMClient([ask_user_response, final_response])

    use_case = RunAgentUseCase(
        llm_client_factory=lambda _: llm_client,
        session_store=store,
        agent_definitions=default_agent_def,
        tool_executor=tool_registry,
        is_api_context=False,
    )

    result = use_case.execute(
        RunAgentRequest(message="Should I proceed?", agent_id="default")
    )
    assert isinstance(result, RunAgentPaused)

    result2 = use_case.continue_sync(
        ContinueRequest(session_id=result.session_id, answers={"OK?": "yes"})
    )

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]

    assert "ask_user.pause" in event_names
    assert "ask_user.resume" in event_names
    assert "ask_user.answered" in event_names
    assert isinstance(result2, RunAgentResponse)


# ---------------------------------------------------------------------------
# Integration: stream
# ---------------------------------------------------------------------------


def test_stream_run_emits_events(logging_use_case, temp_log_path, default_agent_def):
    """Streaming run emits agent.run.start, react.round.*, agent.run.end."""
    llm_client = _RecordingLLMClient([_make_llm_response(content="Streaming hi.")])
    use_case = logging_use_case(llm_client)

    events_gen = use_case.execute_stream(
        RunAgentRequest(message="Hello", agent_id="default")
    )
    dto_events = list(events_gen)

    log_events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in log_events]

    assert "agent.run.start" in event_names
    assert "react.round.start" in event_names
    assert "react.round.end" in event_names
    assert "agent.run.end" in event_names

    # Last DTO event should be StreamComplete
    assert isinstance(dto_events[-1], StreamComplete)


def test_stream_run_with_tool_calls(logging_use_case, temp_log_path, default_agent_def):
    """Streaming tool calls produce tool events."""
    tool_response = _make_llm_response(
        content="Processing...",
        tool_calls=[
            ToolCall(
                id="call_st1",
                type="function",
                function={"name": "concat", "arguments": '{"a":"a","b":"b"}'},
            )
        ],
    )
    final_response = _make_llm_response(content="Result: ab")

    llm_client = _RecordingLLMClient([tool_response, final_response])
    use_case = logging_use_case(llm_client)

    dto_events = list(
        use_case.execute_stream(
            RunAgentRequest(message="concat a b", agent_id="default")
        )
    )

    log_events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in log_events]

    assert "tool.call.start" in event_names
    assert "tool.call.end" in event_names
    assert isinstance(dto_events[-1], StreamComplete)


# ---------------------------------------------------------------------------
# Error events
# ---------------------------------------------------------------------------


def test_agent_run_error_event(logging_use_case, temp_log_path, default_agent_def):
    """Agent run error emits agent.run.error."""

    class _ErrorClient:
        def complete(self, messages, *, tools=None):
            raise LLMError("Simulated error.", display_message="Error.")

        def complete_stream(self, messages, *, tools=None):
            raise LLMError("Simulated error.", display_message="Error.")

    llm_client = _ErrorClient()
    use_case = logging_use_case(llm_client)

    with pytest.raises(LLMError):
        use_case.execute(RunAgentRequest(message="Trigger error", agent_id="default"))

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]

    assert "agent.run.start" in event_names
    assert "agent.run.error" in event_names
    error_event = next(e for e in events if e["event"] == "agent.run.error")
    assert "error" in error_event


def test_react_max_rounds_exceeded(logging_use_case, temp_log_path, default_agent_def):
    """Max rounds exceeded emits react.max_rounds_exceeded."""
    tool_response = _make_llm_response(
        content="looping...",
        tool_calls=[
            ToolCall(
                id="c1",
                type="function",
                function={"name": "concat", "arguments": '{"a":"a","b":"b"}'},
            )
        ],
    )
    responses = [tool_response] * 10
    llm_client = _RecordingLLMClient(responses)
    use_case = logging_use_case(llm_client)

    with pytest.raises(LLMError):
        use_case.execute(RunAgentRequest(message="loop forever", agent_id="default"))

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]
    assert "react.max_rounds_exceeded" in event_names


def test_session_not_found_event(logging_use_case, temp_log_path, default_agent_def):
    """session.not_found is logged when a non-existent session is requested."""
    store = InMemorySessionStore()
    llm_client = _RecordingLLMClient([_make_llm_response("Hi.")])
    use_case = RunAgentUseCase(
        llm_client_factory=lambda _: llm_client,
        session_store=store,
        agent_definitions=default_agent_def,
        tool_executor=None,
        is_api_context=False,
    )

    with pytest.raises(SessionNotFoundError):
        use_case.execute(
            RunAgentRequest(
                message="Hello", agent_id="default", session_id="nonexistent"
            )
        )

    events = _read_jsonl(temp_log_path)
    event_names = [e["event"] for e in events]
    assert "session.not_found" in event_names


# ---------------------------------------------------------------------------
# Run ID correlation
# ---------------------------------------------------------------------------


def test_run_id_correlation(logging_use_case, temp_log_path, default_agent_def):
    """Events within one run share the same run_id."""
    llm_client = _RecordingLLMClient([_make_llm_response("First.")])

    # Bind context externally to capture run_id
    ctx_store = {}

    class _ContextCapturingClient:
        def complete(self, messages, *, tools=None):
            ctx_store["captured_run_id"] = obs._run_id.get()
            return llm_client.complete(messages, tools=tools)

        def complete_stream(self, messages, *, tools=None):
            return llm_client.complete_stream(messages, tools=tools)

    use_case = logging_use_case(_ContextCapturingClient())
    use_case.execute(RunAgentRequest(message="Test", agent_id="default"))

    events = _read_jsonl(temp_log_path)
    run_ids = {e["run_id"] for e in events}
    assert len(run_ids) == 1
    assert list(run_ids)[0] == ctx_store["captured_run_id"]


# ---------------------------------------------------------------------------
# CLI and HTTP error events
# ---------------------------------------------------------------------------


def test_cli_turn_error_event(monkeypatch, temp_log_path):
    """CLI error handler emits cli.turn.error."""
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.log_event("cli.turn.error", error=obs.summarize_payload("Something broke"))

    events = _read_jsonl(temp_log_path)
    assert events[0]["event"] == "cli.turn.error"
    assert "error" in events[0]


def test_http_request_error_event(monkeypatch, temp_log_path):
    """HTTP error handler emits http.request.error."""
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.log_event(
        "http.request.error",
        error=obs.summarize_payload("404 not found"),
    )

    events = _read_jsonl(temp_log_path)
    assert events[0]["event"] == "http.request.error"
    assert "error" in events[0]


# ---------------------------------------------------------------------------
# LLM request/stream events
# ---------------------------------------------------------------------------


def test_llm_stream_events(monkeypatch, temp_log_path):
    """llm.stream.* events are emitted by the LLM client."""
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.bind_log_context(run_id="r1", session_id="s1", agent_id="default", mode="cli")
    obs.log_event(
        "llm.stream.start",
        model="gpt-4.1-mini",
        api_type="completion",
        stream=True,
        message_count=3,
    )
    obs.log_event(
        "llm.stream.end",
        model="gpt-4.1-mini",
        api_type="completion",
        stream=True,
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        elapsed_ms=1234,
        tool_call_count=0,
    )

    events = _read_jsonl(temp_log_path)
    assert events[0]["event"] == "llm.stream.start"
    assert events[0]["model"] == "gpt-4.1-mini"
    assert events[0]["stream"] is True
    assert events[1]["event"] == "llm.stream.end"
    assert events[1]["usage"]["total_tokens"] == 15


def test_llm_request_events(monkeypatch, temp_log_path):
    """llm.request.* events are emitted by the LLM client."""
    _reset_observability_state()
    monkeypatch.setenv("SIMPLE_AGENT_LOG_ENABLED", "true")
    monkeypatch.setenv("SIMPLE_AGENT_LOG_FILE", str(temp_log_path))
    obs.configure_logging()

    obs.bind_log_context(run_id="r1", session_id="s1", agent_id="default", mode="cli")
    obs.log_event(
        "llm.request.start",
        model="gpt-4.1-mini",
        api_type="completion",
        stream=False,
        message_count=2,
    )
    obs.log_event(
        "llm.request.end",
        model="gpt-4.1-mini",
        api_type="completion",
        stream=False,
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        elapsed_ms=567,
        tool_call_count=0,
    )

    events = _read_jsonl(temp_log_path)
    assert events[0]["event"] == "llm.request.start"
    assert events[0]["stream"] is False
    assert events[1]["event"] == "llm.request.end"
    assert events[1]["usage"]["total_tokens"] == 15
