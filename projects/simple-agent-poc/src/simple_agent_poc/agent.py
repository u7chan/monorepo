"""Agent logic - business logic layer."""

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.llm_client import LiteLLMClient
from simple_agent_poc.types import LLMResponse, Message


class Agent:
    """Simple Agent that manages conversation with LLM."""

    def __init__(self, llm_client: LLMClient | None = None) -> None:
        """Initialize the Agent with an optional LLM client.

        Args:
            llm_client: Optional LLM client. If not provided, uses default LiteLLMClient.
        """
        self._client: LLMClient = llm_client or LiteLLMClient(model="gpt-4.1-nano")
        self._messages: list[Message] = []

    def process_user_input(self, user_input: str) -> LLMResponse:
        """Process user input and return the agent's response.

        Args:
            user_input: The user's input message.

        Returns:
            The LLM response containing content and usage information.
        """
        self._messages.append({"content": user_input, "role": "user"})
        response = self._client.complete(self._messages)
        self._messages.append({"content": response["content"], "role": "assistant"})
        return response
