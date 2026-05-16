"""Fixtures for simple-agent-poc tests."""

import pytest

from simple_agent_poc.adapters.tools.concat import TOOL_DEFINITION as CONCAT_TOOL_DEF
from simple_agent_poc.adapters.tools.concat import execute as concat_execute
from simple_agent_poc.adapters.tools.get_current_time import (
    TOOL_DEFINITION as TIME_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.get_current_time import (
    execute as time_execute,
)
from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import ToolCall


@pytest.fixture
def default_agent_def():
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "test-model",
                    "system_prompt": "You are a helpful assistant.",
                },
            },
        }
    )


@pytest.fixture
def agent_def_with_tools():
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "test-model",
                    "system_prompt": "You are a helpful assistant with tools.",
                    "tools": ["get_current_time", "concat"],
                },
            },
        }
    )


@pytest.fixture
def tool_registry():
    registry = BuiltinToolRegistry()
    registry.register(TIME_TOOL_DEF, time_execute)
    registry.register(CONCAT_TOOL_DEF, concat_execute)
    return registry


@pytest.fixture
def concat_tool_call():
    return ToolCall(
        id="call_001",
        type="function",
        function={
            "name": "concat",
            "arguments": '{"a": "hello", "b": "world"}',
        },
    )


@pytest.fixture
def time_tool_call():
    return ToolCall(
        id="call_002",
        type="function",
        function={
            "name": "get_current_time",
            "arguments": "{}",
        },
    )
