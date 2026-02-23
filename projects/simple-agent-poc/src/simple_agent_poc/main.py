from dotenv import load_dotenv

from simple_agent_poc.agent import Agent
from simple_agent_poc.renderer import (
    get_user_input,
    show_agent_response,
    show_exit_message,
    show_welcome,
)

load_dotenv()


def main() -> None:
    # UI layer: screen rendering
    show_welcome()

    # Business logic layer: initialize Agent
    agent = Agent()

    # CLI loop
    while True:
        try:
            # UI layer: user input
            user_input = get_user_input()
            if not user_input.strip():
                continue

            # Business logic layer: process request
            response = agent.process_user_input(user_input)

            # UI layer: display results
            show_agent_response(response)

        except KeyboardInterrupt:
            show_exit_message()
            break


if __name__ == "__main__":
    main()
