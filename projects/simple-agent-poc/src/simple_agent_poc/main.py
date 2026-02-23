from dotenv import load_dotenv
from litellm import completion

load_dotenv()


def get_agent_response(messages: list[dict]) -> str:
    response = completion(
        model="gpt-4.1-nano",
        messages=messages,
        stream=False,
    )
    return response.choices[0].message.content


def main():
    print("═" * 40)
    print("  ✨  Welcome to Simple Agent POC  ✨")
    print("     (Press Ctrl+C to exit)")
    print("═" * 40)
    print()

    messages: list[dict] = []

    while True:
        try:
            user_input = input("> ")
            if not user_input.strip():
                continue
            messages.append({"content": user_input, "role": "user"})
            response = get_agent_response(messages)
            messages.append({"content": response, "role": "assistant"})
            print(f"Agent: {response}")
        except KeyboardInterrupt:
            print("\nExiting...")
            break


if __name__ == "__main__":
    main()
