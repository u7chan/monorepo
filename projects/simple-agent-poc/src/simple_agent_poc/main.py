from dotenv import load_dotenv

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.llm_client import LiteLLMClient
from simple_agent_poc.types import Message

load_dotenv()


def get_agent_response(client: LLMClient, messages: list[Message]) -> str:
    """Get agent response using the LLM client"""
    return client.complete(messages)


def main() -> None:
    print("═" * 40)
    print("  ✨  Welcome to Simple Agent POC  ✨")
    print("     (Press Ctrl+C to exit)")
    print("═" * 40)
    print()

    # Dependency injection
    llm_client: LLMClient = LiteLLMClient(model="gpt-4.1-nano")

    messages: list[Message] = []

    while True:
        try:
            user_input = input("> ")
            if not user_input.strip():
                continue
            messages.append({"content": user_input, "role": "user"})
            response = get_agent_response(llm_client, messages)
            messages.append({"content": response, "role": "assistant"})
            print(f"Agent: {response}")
        except KeyboardInterrupt:
            print("\nExiting...")
            break


if __name__ == "__main__":
    main()
