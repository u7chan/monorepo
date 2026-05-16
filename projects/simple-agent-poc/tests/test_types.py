"""Tests for core types and session changes."""

from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import ToolCall


def test_message_role_includes_tool():
    from simple_agent_poc.core.types import MessageRole
    tool_msg: MessageRole = "tool"
    assert tool_msg == "tool"


def test_tool_call_typed_dict():
    tc: ToolCall = {
        "id": "call_001",
        "type": "function",
        "function": {"name": "concat", "arguments": '{"a":"1","b":"2"}'},
    }
    assert tc["id"] == "call_001"
    assert tc["function"]["name"] == "concat"


def test_session_append_assistant_with_tool_calls():
    session = ConversationSession.start(
        session_id="s1",
        system_prompt="test",
    )
    tool_calls: list[ToolCall] = [{
        "id": "call_001",
        "type": "function",
        "function": {"name": "concat", "arguments": '{"a":"1","b":"2"}'},
    }]
    session.append_assistant_message("Using tool...", tool_calls=tool_calls)
    assert session.messages[-1]["tool_calls"] == tool_calls


def test_session_append_assistant_without_tool_calls():
    session = ConversationSession.start(
        session_id="s1",
        system_prompt="test",
    )
    session.append_assistant_message("Hello")
    assert "tool_calls" not in session.messages[-1]
    assert session.messages[-1]["content"] == "Hello"


def test_session_append_tool_message():
    session = ConversationSession.start(
        session_id="s1",
        system_prompt="test",
    )
    session.append_tool_message('{"result":"ok"}', tool_call_id="call_001")
    msg = session.messages[-1]
    assert msg["role"] == "tool"
    assert msg["content"] == '{"result":"ok"}'
    assert msg["tool_call_id"] == "call_001"
