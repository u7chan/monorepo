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
    LLMResponse,
    LLMStreamChunk,
    Message,
    RateLimitError,
    ToolCall,
    ToolCallDelta,
    ToolDefinition,
)

warnings.filterwarnings(
    "ignore",
    message="Pydantic serializ",
)


def _parse_tool_calls(raw_tool_calls) -> list[ToolCall]:
    result: list[ToolCall] = []
    for tc in raw_tool_calls:
        result.append({
            "id": tc.id,
            "type": "function",
            "function": {
                "name": tc.function.name,
                "arguments": tc.function.arguments,
            },
        })
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


class LiteLLMCompletionClient(LLMClient):
    """LLM client using litellm.completion()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> LLMResponse:
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
                stream=False,
                **completion_params,
            )
        except LiteLLMAuthError as error:
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
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

        elapsed = time.perf_counter() - start_time
        result: LLMResponse = {
            "content": response.choices[0].message.content or "",
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "model": self.model,
            "response_time": elapsed,
        }
        raw_tool_calls = getattr(
            response.choices[0].message, "tool_calls", None
        )
        if raw_tool_calls:
            result["tool_calls"] = _parse_tool_calls(raw_tool_calls)
        return result

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
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
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
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
                        yield tc_chunk
            if hasattr(chunk, "usage") and chunk.usage is not None:
                chunk_data["usage"] = {
                    "prompt_tokens": chunk.usage.prompt_tokens,
                    "completion_tokens": chunk.usage.completion_tokens,
                    "total_tokens": chunk.usage.total_tokens,
                }
            if chunk_data["content_delta"] is not None or "usage" in chunk_data:
                yield chunk_data


class LiteLLMResponsesClient(LLMClient):
    """LLM client using litellm.responses()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> LLMResponse:
        start_time = time.perf_counter()
        response_params: dict[str, object] = {}
        if self.temperature is not None:
            response_params["temperature"] = self.temperature
        if tools:
            response_params["tools"] = tools

        try:
            response = responses(
                input=messages,
                model=self.model,
                stream=False,
                **response_params,
            )
        except LiteLLMAuthError as error:
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
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

        elapsed = time.perf_counter() - start_time
        return {
            "content": response.output_text,
            "usage": {
                "prompt_tokens": response.usage.input_tokens,
                "completion_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "model": self.model,
            "response_time": elapsed,
        }

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
        response_params: dict[str, object] = {}
        if self.temperature is not None:
            response_params["temperature"] = self.temperature
        if tools:
            response_params["tools"] = tools

        try:
            response = responses(
                input=messages,
                model=self.model,
                stream=True,
                **response_params,
            )
        except LiteLLMAuthError as error:
            raise AuthenticationError(
                message=str(error),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from error
        except LiteLLMRateLimitError as error:
            raise RateLimitError(
                message=str(error),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from error
        except Exception as error:
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

        for event in response:
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
            if chunk_data["content_delta"] is not None or "usage" in chunk_data:
                yield chunk_data


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
