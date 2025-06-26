import requests

BASE_URL = "http://localhost:8000"


def fetch_session_id(agent_id: str, user_id: str) -> str:
    """
    Fetches a session ID for a given agent and user.

    Args:
        agent_id (str): The ID of the agent.
        user_id (str): The ID of the user.

    Returns:
        str: The session ID.
    """
    url = f"{BASE_URL}/apps/{agent_id}/users/{user_id}/sessions"
    print(f"Fetching session ID from: {url}")
    # Make a POST request to the specified URL
    response = requests.post(url, json={})
    response.raise_for_status()
    return response.json().get("id")


def run_agent(agent_id: str, user_id: str, session_id: str, content: str):
    """
    Runs the agent with the specified session ID.

    Args:
        agent_id (str): The ID of the agent.
        user_id (str): The ID of the user.
        session_id (str): The session ID to use.
    """
    url = f"{BASE_URL}/run"
    print(f"Running agent at: {url}")
    response = requests.post(
        url,
        json={
            "appName": agent_id,
            "userId": user_id,
            "sessionId": session_id,
            "newMessage": {"parts": [{"text": content}], "role": "user"},
            "streaming": False,
        },
    )
    response.raise_for_status()
    return response.json()


def main():
    agent_id = "hello_agent"
    user_id = "test1234"

    session_id = fetch_session_id(agent_id, user_id)
    print(f"Session ID: {session_id}")

    result = run_agent(agent_id, user_id, session_id, "Hello, how are you?")
    print("Agent response:", result)


if __name__ == "__main__":
    main()
