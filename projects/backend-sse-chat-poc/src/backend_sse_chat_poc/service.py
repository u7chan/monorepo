from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress

from fastapi import Request

from backend_sse_chat_poc.llm import ChatStreamer
from backend_sse_chat_poc.store import InMemoryConversationStore


class ChatService:
    def __init__(
        self, *, store: InMemoryConversationStore, streamer: ChatStreamer
    ) -> None:
        self._store = store
        self._streamer = streamer
        self._tasks: set[asyncio.Task[None]] = set()

    async def ensure_conversation(self, conversation_id: str) -> None:
        await self._store.ensure_conversation(conversation_id)

    async def get_state(self, conversation_id: str) -> dict[str, object]:
        return await self._store.get_state(conversation_id)

    async def create_message(
        self, conversation_id: str, content: str
    ) -> dict[str, object]:
        draft = await self._store.create_turn(conversation_id, content)
        task = asyncio.create_task(
            self._run_generation(conversation_id, draft.generation.id)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return {
            "conversation_id": draft.conversation_id,
            "user_message": draft.user_message.to_dict(),
            "assistant_message": draft.assistant_message.to_dict(),
            "generation": draft.generation.to_dict(),
        }

    async def stream_events(
        self,
        *,
        conversation_id: str,
        request: Request,
        after_event_id: int,
    ) -> AsyncIterator[str]:
        queue = await self._store.subscribe(
            conversation_id, after_event_id=after_event_id
        )
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield event.encode()
        finally:
            await self._store.unsubscribe(conversation_id, queue)

    async def shutdown(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        for task in list(self._tasks):
            with suppress(asyncio.CancelledError):
                await task

    async def _run_generation(self, conversation_id: str, generation_id: str) -> None:
        try:
            prompt_messages = await self._store.build_prompt_messages(
                conversation_id, generation_id
            )
            await self._store.mark_generation_started(conversation_id, generation_id)
            async for delta in self._streamer.stream_reply(prompt_messages):
                if delta:
                    await self._store.append_delta(
                        conversation_id, generation_id, delta
                    )
            await self._store.complete_generation(conversation_id, generation_id)
        except Exception as exc:  # noqa: BLE001
            await self._store.fail_generation(conversation_id, generation_id, str(exc))
