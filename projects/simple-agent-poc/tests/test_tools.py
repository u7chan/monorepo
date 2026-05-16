"""Tests for built-in tool execution and registry."""

import json

from simple_agent_poc.adapters.tools.concat import TOOL_DEFINITION as CONCAT_TOOL_DEF
from simple_agent_poc.adapters.tools.concat import execute as concat_execute
from simple_agent_poc.adapters.tools.get_current_time import (
    TOOL_DEFINITION as TIME_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.get_current_time import (
    execute as time_execute,
)


def test_concat_execution():
    result = concat_execute({"a": "hello", "b": "world"})
    data = json.loads(result)
    assert data["result"] == "helloworld"


def test_get_current_time_execution():
    result = time_execute({})
    data = json.loads(result)
    assert "datetime" in data


def test_registry_execute_concat(tool_registry, concat_tool_call):
    result = tool_registry.execute(concat_tool_call)
    data = json.loads(result)
    assert data["result"] == "helloworld"


def test_registry_execute_time(tool_registry, time_tool_call):
    result = tool_registry.execute(time_tool_call)
    data = json.loads(result)
    assert "datetime" in data


def test_registry_get_definitions(tool_registry):
    defs = tool_registry.get_definitions(["get_current_time", "concat"])
    assert len(defs) == 2
    names = {d["function"]["name"] for d in defs}
    assert names == {"get_current_time", "concat"}


def test_registry_get_definitions_partial(tool_registry):
    defs = tool_registry.get_definitions(["get_current_time", "nonexistent"])
    assert len(defs) == 1
    assert defs[0]["function"]["name"] == "get_current_time"


def test_tool_definition_schema():
    assert CONCAT_TOOL_DEF["type"] == "function"
    assert CONCAT_TOOL_DEF["function"]["name"] == "concat"
    params = CONCAT_TOOL_DEF["function"]["parameters"]
    assert "a" in params["properties"]
    assert "b" in params["properties"]


def test_time_definition_schema():
    assert TIME_TOOL_DEF["type"] == "function"
    assert TIME_TOOL_DEF["function"]["name"] == "get_current_time"
