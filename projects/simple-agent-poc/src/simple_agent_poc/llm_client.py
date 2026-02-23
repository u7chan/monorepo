from litellm import completion

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.types import LLMResponse, Message


class LiteLLMClient(LLMClient):
    """LLM client implementation using LiteLLM"""

    def __init__(self, model: str) -> None:
        self.model = model

    def complete(self, messages: list[Message]) -> LLMResponse:
        response = completion(
            model=self.model,
            messages=messages,
            stream=False,
        )
        return {
            "content": response.choices[0].message.content,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
        }
