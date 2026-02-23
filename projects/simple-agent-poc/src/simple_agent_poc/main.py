from dotenv import load_dotenv
from litellm import completion

load_dotenv()


def get_agent_response(user_input: str) -> str:
    response = completion(
        model="gpt-4.1-nano",
        messages=[{"content": user_input, "role": "user"}],
        stream=False,
    )
    return response.choices[0].message.content


def main():
    print("═" * 40)
    print("  ✨  Welcome to Simple Agent POC  ✨")
    print("     (Press Ctrl+C to exit)")
    print("═" * 40)
    print()

    while True:
        try:
            user_input = input("> ")
            if not user_input.strip():
                continue
            response = get_agent_response(user_input)
            print(f"Agent: {response}")
        except KeyboardInterrupt:
            print("\nExiting...")
            break


if __name__ == "__main__":
    main()
