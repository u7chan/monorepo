def get_agent_response(user_input: str) -> str:
    return "Hello! How can I assist you today?"


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
