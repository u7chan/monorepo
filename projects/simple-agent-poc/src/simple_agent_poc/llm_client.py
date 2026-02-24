"""LLM client implementation."""

import time

from litellm import completion
from litellm.exceptions import (
    AuthenticationError as LiteLLMAuthError,
    RateLimitError as LiteLLMRateLimitError,
)

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.types import (
    LLMResponse,
    Message,
    AuthenticationError,
    RateLimitError,
    LLMError,
)


class LiteLLMClient(LLMClient):
    """LLM client implementation using LiteLLM"""

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
        except LiteLLMAuthError as e:
            raise AuthenticationError(
                message=str(e),
                display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
            ) from e
        except LiteLLMRateLimitError as e:
            raise RateLimitError(
                message=str(e),
                display_message="Rate limit exceeded. Please wait a moment before trying again.",
            ) from e
        except Exception as e:
            error_msg = str(e).lower()
            if (
                "authentication" in error_msg
                or "api key" in error_msg
                or "401" in error_msg
            ):
                raise AuthenticationError(
                    message=str(e),
                    display_message="Authentication failed: Invalid API key. Please check your API_KEY setting.",
                ) from e
            raise LLMError(
                message=str(e),
                display_message=f"An error occurred while communicating with the LLM: {e}",
            ) from e

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
