"""Agent logic - business logic layer."""

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.llm_client import LiteLLMClient
from simple_agent_poc.types import LLMResponse, Message, ValidationError


class Agent:
    """Simple Agent that manages conversation with LLM."""

    def __init__(
        self,
        *,
        system_prompt: str,
        model: str,
        llm_client: LLMClient | None = None,
    ) -> None:
        """Initialize the Agent with required configuration.

        Args:
            system_prompt: System prompt for the agent (required). Should be pre-formatted.
            model: Model name to use (required).
            llm_client: Optional LLM client. If not provided, uses default LiteLLMClient.

        Raises:
            ValidationError: If system_prompt or model is not provided.
        """
        if not system_prompt:
            raise ValidationError("system_prompt is required")
        if not model:
            raise ValidationError("model is required")

        self._client: LLMClient = llm_client or LiteLLMClient(model=model)
        self._messages: list[Message] = [{"role": "system", "content": system_prompt}]
        self._system_prompt = system_prompt

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
