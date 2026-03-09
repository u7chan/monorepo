"""LLM client implementation."""

import time

from litellm import completion
from litellm.exceptions import (
    AuthenticationError as LiteLLMAuthError,
    RateLimitError as LiteLLMRateLimitError,
)

from simple_agent_poc.application.ports import LLMClient
from simple_agent_poc.core.types import (
    AuthenticationError,
    LLMError,
    LLMResponse,
    Message,
    RateLimitError,
)


class LiteLLMClient(LLMClient):
    """LLM client implementation using LiteLLM."""

    def __init__(self, model: str) -> None:
        self.model = model

    def complete(self, messages: list[Message]) -> LLMResponse:
        start_time = time.perf_counter()
        try:
            response = completion(
                model=self.model,
                messages=messages,
                stream=False,
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
