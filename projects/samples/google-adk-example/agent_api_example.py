import json

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


def run_agent_stream(agent_id: str, user_id: str, session_id: str, content: str):
    """
    Runs the agent with the specified session ID in streaming mode.

    Args:
        agent_id (str): The ID of the agent.
        user_id (str): The ID of the user.
        session_id (str): The session ID to use.
    """
    url = f"{BASE_URL}/run_sse"
    print(f"Running agent at: {url}")
    response = requests.post(
        url,
        json={
            "appName": agent_id,
            "userId": user_id,
            "sessionId": session_id,
            "newMessage": {"parts": [{"text": content}], "role": "user"},
        },
        stream=True,
    )
    response.raise_for_status()
    response_iterator = response.iter_lines()
    for line in response_iterator:
        if line:
            decoded_line = line.decode("utf-8")
            if decoded_line.startswith("data: "):
                yield decoded_line[6:]


def main():
    agent_id = "hello_agent"
    user_id = "test1234"

    session_id = fetch_session_id(agent_id, user_id)
    print(f"Session ID: {session_id}")

    print("\n--- Running non-streaming agent ---")
    result = run_agent(agent_id, user_id, session_id, "Hello, how are you?")
    print("Agent response:", result)
    print("-" * 20)

    print("\n--- Running streaming agent (SSE) ---")
    stream = run_agent_stream(agent_id, user_id, session_id, "しりとりしよう")
    full_response = ""
    final_chunk = None
    for chunk in stream:
        final_chunk = chunk
        try:
            data = json.loads(chunk)
            if "content" in data and "parts" in data["content"]:
                text_part = data["content"]["parts"][0]["text"]
                # Print only the new part of the text
                if text_part.startswith(full_response):
                    new_text = text_part[len(full_response) :]
                    print(new_text, end="", flush=True)
                    full_response = text_part
                else:  # If response is reset or completely different
                    print(f"\n{text_part}", end="", flush=True)
                    full_response = text_part
        except json.JSONDecodeError:
            # This can happen with sentinel values or empty lines
            pass

    if final_chunk:
        print("\n\n--- Final Message (from stream) ---")
        try:
            # Pretty print the final JSON object
            print(json.dumps(json.loads(final_chunk), indent=2, ensure_ascii=False))
        except json.JSONDecodeError:
            print(f"Could not parse final chunk as JSON: {final_chunk}")


if __name__ == "__main__":
    main()
