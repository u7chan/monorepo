"""LLM client implementation."""

import time

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
    Message,
    RateLimitError,
)


class LiteLLMCompletionClient(LLMClient):
    """LLM client using litellm.completion()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete(self, messages: list[Message]) -> LLMResponse:
        start_time = time.perf_counter()
        completion_params: dict[str, float] = {}
        if self.temperature is not None:
            completion_params["temperature"] = self.temperature

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
        return {
            "content": response.choices[0].message.content,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "model": self.model,
            "response_time": elapsed,
        }


class LiteLLMResponsesClient(LLMClient):
    """LLM client using litellm.responses()."""

    def __init__(self, model: str, *, temperature: float | None = None) -> None:
        self.model = model
        self.temperature = temperature

    def complete(self, messages: list[Message]) -> LLMResponse:
        start_time = time.perf_counter()
        response_params: dict[str, float] = {}
        if self.temperature is not None:
            response_params["temperature"] = self.temperature

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
