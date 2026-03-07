from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from httpx import ASGITransport, AsyncClient

from backend_sse_chat_poc.llm import FakeChatStreamer
from backend_sse_chat_poc.main import create_app


@asynccontextmanager
async def client_for(streamer: FakeChatStreamer) -> AsyncIterator[AsyncClient]:
    app = create_app(streamer=streamer)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            yield client


class DisconnectAfter:
    def __init__(self, *, checks_before_disconnect: int) -> None:
        self._checks_remaining = checks_before_disconnect

    async def is_disconnected(self) -> bool:
        self._checks_remaining -= 1
        return self._checks_remaining < 0


async def wait_for_generation_status(
    client: AsyncClient,
    conversation_id: str,
    expected_status: str,
    timeout_seconds: float = 3.0,
) -> dict[str, object]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(f"/conversations/{conversation_id}/state")
        assert response.status_code == 200
        payload = response.json()
        if (
            payload["generations"]
            and payload["generations"][-1]["status"] == expected_status
        ):
            return payload
        await asyncio.sleep(0.05)
    raise AssertionError(f"generation did not reach {expected_status} before timeout")


@pytest.mark.asyncio
async def test_root_redirects_to_new_conversation() -> None:
    async with client_for(FakeChatStreamer(delay_seconds=0)) as client:
        response = await client.get("/", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"].startswith("/conversations/")


@pytest.mark.asyncio
async def test_message_flow_is_restored_via_state_endpoint() -> None:
    async with client_for(
        FakeChatStreamer(chunks=["Hello", " world"], delay_seconds=0)
    ) as client:
        conversation_id = "conversation-state"
        page = await client.get(f"/conversations/{conversation_id}")
        assert page.status_code == 200
        assert conversation_id in page.text

        response = await client.post(
            f"/conversations/{conversation_id}/messages",
            json={"content": "Explain the architecture"},
        )

        assert response.status_code == 202
        payload = response.json()
        assert payload["user_message"]["status"] == "completed"
        assert payload["assistant_message"]["status"] == "queued"
        assert payload["generation"]["status"] == "queued"

        state = await wait_for_generation_status(client, conversation_id, "completed")

    assert [message["role"] for message in state["messages"]] == ["user", "assistant"]
    assert state["messages"][1]["content"] == "Hello world"
    assert state["messages"][1]["status"] == "completed"
    assert state["generations"][0]["sequence"] == 2
    assert state["last_event_id"] == 4


@pytest.mark.asyncio
async def test_sse_endpoint_replays_stored_events() -> None:
    app = create_app(
        streamer=FakeChatStreamer(chunks=["chunk-1", "chunk-2"], delay_seconds=0)
    )
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            conversation_id = "conversation-events"
            await client.post(
                f"/conversations/{conversation_id}/messages",
                json={"content": "Replay events"},
            )
            await wait_for_generation_status(client, conversation_id, "completed")

            service = app.state.chat_service
            stream = service.stream_events(
                conversation_id=conversation_id,
                request=DisconnectAfter(checks_before_disconnect=4),
                after_event_id=0,
            )
            chunks = [chunk async for chunk in stream]

    payload = "".join(chunks)
    assert "event: message_started" in payload
    assert payload.count("event: message_delta") == 2
    assert "event: message_completed" in payload


@pytest.mark.asyncio
async def test_failed_generation_transitions_to_failed_state() -> None:
    async with client_for(
        FakeChatStreamer(chunks=["partial"], delay_seconds=0, error_after_chunks=1),
    ) as client:
        conversation_id = "conversation-failure"
        response = await client.post(
            f"/conversations/{conversation_id}/messages",
            json={"content": "Fail on purpose"},
        )
        assert response.status_code == 202

        state = await wait_for_generation_status(client, conversation_id, "failed")

    assert state["messages"][1]["content"] == "partial"
    assert state["messages"][1]["status"] == "failed"
    assert state["generations"][0]["status"] == "failed"
    assert state["generations"][0]["error"] == "fake upstream stream failed"
