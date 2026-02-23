from litellm import completion

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.types import Message


class LiteLLMClient(LLMClient):
    """LLM client implementation using LiteLLM"""

    def __init__(self, model: str) -> None:
        self.model = model

    def complete(self, messages: list[Message]) -> str:
        response = completion(
            model=self.model,
            messages=messages,
            stream=False,
        )
        return response.choices[0].message.content
