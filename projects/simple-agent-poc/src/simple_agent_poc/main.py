def get_agent_response(user_input: str) -> str:
    return "Hello! How can I assist you today?"


def main():
    print("Hello from simple-agent-poc!")
    print("Chatbot started. Press Ctrl+C to exit.\n")

    while True:
        try:
            user_input = input("> ")
            response = get_agent_response(user_input)
            print(f"Agent: {response}")
        except KeyboardInterrupt:
            print("\nExiting...")
            break


if __name__ == "__main__":
    main()
