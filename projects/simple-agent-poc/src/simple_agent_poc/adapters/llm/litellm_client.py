"""LLM client implementation."""

import time
import warnings
from collections.abc import Iterator

from litellm import completion, responses
from litellm.exceptions import (
    AuthenticationError as LiteLLMAuthError,
    RateLimitError as LiteLLMRateLimitError,
)

from simple_agent_poc.application.ports import LLMClient
from simple_agent_poc.core.agent_definition import AgentDefinition
from simple_agent_poc.core.types import (
    AuthenticationError,
    LLMError,
    LLMStreamChunk,
    Message,
    RateLimitError,
    ToolCall,
    ToolCallDelta,
    ToolDefinition,
    Usage,
)
from simple_agent_poc.observability import log_event, summarize_payload

warnings.filterwarnings(
    "ignore",
    message="Pydantic serializ",
)


def _parse_tool_calls(raw_tool_calls) -> list[ToolCall]:
    result: list[ToolCall] = []
    for tc in raw_tool_calls:
        result.append(
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
        )
    return result


def _parse_tool_call_delta(raw_tool_calls) -> list[ToolCallDelta]:
    result: list[ToolCallDelta] = []
    for tc in raw_tool_calls:
        fn_name: str | None = None
        fn_args: str | None = None
        if tc.function and tc.function.name:
            fn_name = tc.function.name
        if tc.function and tc.function.arguments:
            fn_args = tc.function.arguments
        td: ToolCallDelta = {
            "index": tc.index,
            "id": tc.id,
            "type": "function",
            "function": {
                "name": fn_name,
                "arguments": fn_args,
            },
        }
        result.append(td)
    return result


def _item_type(item) -> str | None:
    if isinstance(item, dict):
        return item.get("type")
    return getattr(item, "type", None)


def _item_attr(item, attr: str, default=None):
    if isinstance(item, dict):
        return item.get(attr, default)
    return getattr(item, attr, default)


def _transform_messages_for_responses(
    messages: list[Message],
) -> list[dict]:
    result: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            result.append(
                {
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id", ""),
                    "output": msg.get("content", ""),
                }
            )
            continue

        item: dict = {"role": role, "content": msg.get("content", "")}
        result.append(item)

        tool_calls = msg.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                result.append(
                    {
                        "type": "function_call",
                        "call_id": tc.get("id", ""),
                        "name": tc["function"]["name"],
                        "arguments": tc["function"]["arguments"],
                    }
                )
    return result


def _transform_tools_for_responses(
    tools: list[ToolDefinition],
) -> list[dict]:
    result: list[dict] = []
    for tool in tools:
        func = tool["function"]
        result.append(
            {
                "type": tool["type"],
                "name": func["name"],
                "description": func["description"],
                "parameters": func["parameters"],
            }
        )
    return result


def _parse_tool_calls_from_responses_output(output) -> list[ToolCall]:
    result: list[ToolCall] = []
    for item in output:
        if _item_type(item) == "function_call":
            result.append(
                {
                    "id": _item_attr(item, "call_id", ""),
                    "type": "function",
                    "function": {
                        "name": _item_attr(item, "name", ""),
                        "arguments": _item_attr(item, "arguments", ""),
                    },
                }
            )
    return result


class LiteLLMCompletionClient(LLMClient):
    """LLM client using litellm.completion()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
        log_event(
            "llm.stream.start",
            model=self.model,
            api_type="completion",
            stream=True,
            message_count=len(messages),
        )
        start_time = time.perf_counter()
        completion_params: dict[str, object] = {}
        if self.temperature is not None:
            completion_params["temperature"] = self.temperature
        if tools:
            completion_params["tools"] = tools

        try:
            response = completion(
                model=self.model,
                messages=messages,
                stream=True,
                stream_options={"include_usage": True},
                **completion_params,
            )
        except LiteLLMAuthError as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            error_msg = str(error).lower()
            if (
                "authentication" in error_msg
                or "api key" in error_msg
                or "401" in error_msg
            ):
                raise AuthenticationError(
                    message=str(error),
                    display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
                ) from error
            raise LLMError(
                message=str(error),
                display_message=f"An error occurred while communicating with the LLM: {error}",
            ) from error

        last_usage: Usage | None = None
        tool_call_count = 0
        seen_call_ids: set[str] = set()
        for chunk in response:
            chunk_data: LLMStreamChunk = {"content_delta": None}
            if chunk.choices:
                delta = chunk.choices[0].delta
                if delta.content:
                    chunk_data["content_delta"] = delta.content
                if hasattr(delta, "tool_calls") and delta.tool_calls:
                    tc_deltas = _parse_tool_call_delta(delta.tool_calls)
                    for td in tc_deltas:
                        tc_chunk: LLMStreamChunk = {
                            "content_delta": None,
                            "tool_call_delta": td,
                        }
                        call_id = td.get("id")
                        if call_id and call_id not in seen_call_ids:
                            seen_call_ids.add(call_id)
                            tool_call_count += 1
                        yield tc_chunk
            if hasattr(chunk, "usage") and chunk.usage is not None:
                chunk_data["usage"] = {
                    "prompt_tokens": chunk.usage.prompt_tokens,
                    "completion_tokens": chunk.usage.completion_tokens,
                    "total_tokens": chunk.usage.total_tokens,
                }
                last_usage = chunk_data["usage"]
            if chunk_data["content_delta"] is not None or "usage" in chunk_data:
                yield chunk_data

        elapsed = time.perf_counter() - start_time
        log_event(
            "llm.stream.end",
            model=self.model,
            api_type="completion",
            stream=True,
            usage=last_usage,
            elapsed_ms=int(elapsed * 1000),
            tool_call_count=tool_call_count,
        )


class LiteLLMResponsesClient(LLMClient):
    """LLM client using litellm.responses()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
        log_event(
            "llm.stream.start",
            model=self.model,
            api_type="responses",
            stream=True,
            message_count=len(messages),
        )
        start_time = time.perf_counter()
        response_params: dict[str, object] = {}
        if self.temperature is not None:
            response_params["temperature"] = self.temperature
        if tools:
            response_params["tools"] = _transform_tools_for_responses(tools)

        try:
            response = responses(
                input=_transform_messages_for_responses(messages),
                model=self.model,
                stream=True,
                **response_params,
            )
        except LiteLLMAuthError as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
            log_event(
                "llm.stream.error",
                error=summarize_payload(str(error)),
            )
            error_msg = str(error).lower()
            if (
                "authentication" in error_msg
                or "api key" in error_msg
                or "401" in error_msg
            ):
                raise AuthenticationError(
                    message=str(error),
                    display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
                ) from error
            raise LLMError(
                message=str(error),
                display_message=f"An error occurred while communicating with the LLM: {error}",
            ) from error

        call_ids_by_output_index: dict[int, str] = {}
        last_usage: Usage | None = None
        tool_call_count = 0
        for event in response:
            event_type = getattr(event, "type", None)

            if event_type == "response.output_item.added":
                item = getattr(event, "item", None)
                if item is not None and _item_type(item) == "function_call":
                    output_index = getattr(event, "output_index", 0)
                    call_id = _item_attr(item, "call_id", None)
                    if call_id:
                        call_ids_by_output_index[output_index] = call_id
                        tool_call_count += 1
                    td: ToolCallDelta = {
                        "index": output_index,
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": _item_attr(item, "name", None),
                            "arguments": _item_attr(item, "arguments", None),
                        },
                    }
                    yield {"content_delta": None, "tool_call_delta": td}
                continue

            if event_type == "response.function_call_arguments.delta":
                output_index = getattr(event, "output_index", 0)
                td: ToolCallDelta = {
                    "index": output_index,
                    "id": call_ids_by_output_index.get(output_index),
                    "type": "function",
                    "function": {
                        "name": None,
                        "arguments": getattr(event, "delta", None),
                    },
                }
                yield {"content_delta": None, "tool_call_delta": td}
                continue

            chunk_data: LLMStreamChunk = {"content_delta": None}
            if hasattr(event, "delta") and event.delta:
                chunk_data["content_delta"] = event.delta
            if hasattr(event, "response") and hasattr(event.response, "usage"):
                usage_obj = event.response.usage
                if usage_obj is not None:
                    chunk_data["usage"] = {
                        "prompt_tokens": usage_obj.input_tokens,
                        "completion_tokens": usage_obj.output_tokens,
                        "total_tokens": usage_obj.total_tokens,
                    }
                    last_usage = chunk_data["usage"]
            if chunk_data["content_delta"] is not None or "usage" in chunk_data:
                yield chunk_data

        elapsed = time.perf_counter() - start_time
        log_event(
            "llm.stream.end",
            model=self.model,
            api_type="responses",
            stream=True,
            usage=last_usage,
            elapsed_ms=int(elapsed * 1000),
            tool_call_count=tool_call_count,
        )


class LiteLLMClientFactory:
    """Create LiteLLM clients from agent definitions."""

    def __call__(self, agent_definition: AgentDefinition) -> LLMClient:
        if agent_definition.api_type == "responses":
            return LiteLLMResponsesClient(
                model=agent_definition.model,
                temperature=agent_definition.temperature,
            )
        return LiteLLMCompletionClient(
            model=agent_definition.model,
            temperature=agent_definition.temperature,
        )
