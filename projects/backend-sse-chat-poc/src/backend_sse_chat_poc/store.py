from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any
from uuid import uuid4

from backend_sse_chat_poc.models import (
    Conversation,
    ConversationEvent,
    Generation,
    GenerationStatus,
    Message,
    MessageRole,
    MessageStatus,
    TurnDraft,
)


class InMemoryConversationStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._conversations: dict[str, Conversation] = {}
        self._messages: dict[str, Message] = {}
        self._generations: dict[str, Generation] = {}
        self._events: dict[str, list[ConversationEvent]] = defaultdict(list)
        self._next_event_ids: dict[str, int] = defaultdict(lambda: 1)
        self._subscribers: dict[str, set[asyncio.Queue[ConversationEvent]]] = (
            defaultdict(set)
        )

    async def ensure_conversation(self, conversation_id: str) -> None:
        async with self._lock:
            self._ensure_conversation_locked(conversation_id)

    async def create_turn(self, conversation_id: str, content: str) -> TurnDraft:
        async with self._lock:
            conversation = self._ensure_conversation_locked(conversation_id)
            user_message = Message(
                id=f"msg_{uuid4().hex}",
                conversation_id=conversation_id,
                role=MessageRole.USER,
                content=content,
                status=MessageStatus.COMPLETED,
            )
            assistant_message = Message(
                id=f"msg_{uuid4().hex}",
                conversation_id=conversation_id,
                role=MessageRole.ASSISTANT,
                content="",
                status=MessageStatus.QUEUED,
            )
            generation = Generation(
                id=f"gen_{uuid4().hex}",
                conversation_id=conversation_id,
                assistant_message_id=assistant_message.id,
                status=GenerationStatus.QUEUED,
            )

            self._messages[user_message.id] = user_message
            self._messages[assistant_message.id] = assistant_message
            self._generations[generation.id] = generation
            conversation.message_ids.extend([user_message.id, assistant_message.id])
            conversation.generation_ids.append(generation.id)

            return TurnDraft(
                conversation_id=conversation_id,
                user_message=user_message,
                assistant_message=assistant_message,
                generation=generation,
            )

    async def build_prompt_messages(
        self, conversation_id: str, generation_id: str
    ) -> list[dict[str, str]]:
        async with self._lock:
            conversation = self._ensure_conversation_locked(conversation_id)
            generation = self._generations[generation_id]
            prompt_messages: list[dict[str, str]] = []
            for message_id in conversation.message_ids:
                if message_id == generation.assistant_message_id:
                    break
                message = self._messages[message_id]
                if message.status == MessageStatus.FAILED:
                    continue
                prompt_messages.append(
                    {
                        "role": message.role.value,
                        "content": message.content,
                    }
                )
            return prompt_messages

    async def mark_generation_started(
        self, conversation_id: str, generation_id: str
    ) -> None:
        async with self._lock:
            generation = self._generations[generation_id]
            message = self._messages[generation.assistant_message_id]
            generation.status = GenerationStatus.STREAMING
            generation.error = None
            generation.touch()
            message.status = MessageStatus.STREAMING
            message.touch()
            self._publish_locked(
                conversation_id,
                "message_started",
                {
                    "generation_id": generation.id,
                    "message_id": message.id,
                    "status": message.status.value,
                    "seq": generation.sequence,
                },
            )

    async def append_delta(
        self, conversation_id: str, generation_id: str, delta: str
    ) -> None:
        async with self._lock:
            generation = self._generations[generation_id]
            message = self._messages[generation.assistant_message_id]
            message.content += delta
            message.touch()
            generation.sequence += 1
            generation.touch()
            self._publish_locked(
                conversation_id,
                "message_delta",
                {
                    "generation_id": generation.id,
                    "message_id": message.id,
                    "seq": generation.sequence,
                    "delta": delta,
                    "version": message.version,
                },
            )

    async def complete_generation(
        self, conversation_id: str, generation_id: str
    ) -> None:
        async with self._lock:
            generation = self._generations[generation_id]
            message = self._messages[generation.assistant_message_id]
            generation.status = GenerationStatus.COMPLETED
            generation.touch()
            message.status = MessageStatus.COMPLETED
            message.touch()
            self._publish_locked(
                conversation_id,
                "message_completed",
                {
                    "generation_id": generation.id,
                    "message_id": message.id,
                    "status": message.status.value,
                    "seq": generation.sequence,
                },
            )

    async def fail_generation(
        self, conversation_id: str, generation_id: str, error: str
    ) -> None:
        async with self._lock:
            generation = self._generations[generation_id]
            message = self._messages[generation.assistant_message_id]
            generation.status = GenerationStatus.FAILED
            generation.error = error
            generation.touch()
            message.status = MessageStatus.FAILED
            message.touch()
            self._publish_locked(
                conversation_id,
                "message_failed",
                {
                    "generation_id": generation.id,
                    "message_id": message.id,
                    "status": message.status.value,
                    "seq": generation.sequence,
                    "error": error,
                },
            )

    async def get_state(self, conversation_id: str) -> dict[str, Any]:
        async with self._lock:
            conversation = self._ensure_conversation_locked(conversation_id)
            last_event_id = (
                self._events[conversation_id][-1].event_id
                if self._events[conversation_id]
                else 0
            )
            return {
                "conversation_id": conversation_id,
                "messages": [
                    self._messages[message_id].to_dict()
                    for message_id in conversation.message_ids
                ],
                "generations": [
                    self._generations[generation_id].to_dict()
                    for generation_id in conversation.generation_ids
                ],
                "last_event_id": last_event_id,
            }

    async def subscribe(
        self, conversation_id: str, after_event_id: int = 0
    ) -> asyncio.Queue[ConversationEvent]:
        async with self._lock:
            self._ensure_conversation_locked(conversation_id)
            queue: asyncio.Queue[ConversationEvent] = asyncio.Queue()
            self._subscribers[conversation_id].add(queue)
            for event in self._events[conversation_id]:
                if event.event_id > after_event_id:
                    queue.put_nowait(event)
            return queue

    async def unsubscribe(
        self, conversation_id: str, queue: asyncio.Queue[ConversationEvent]
    ) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(conversation_id)
            if subscribers is None:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(conversation_id, None)

    def _ensure_conversation_locked(self, conversation_id: str) -> Conversation:
        conversation = self._conversations.get(conversation_id)
        if conversation is None:
            conversation = Conversation(id=conversation_id)
            self._conversations[conversation_id] = conversation
        return conversation

    def _publish_locked(
        self, conversation_id: str, name: str, data: dict[str, Any]
    ) -> None:
        event = ConversationEvent(
            event_id=self._next_event_ids[conversation_id],
            name=name,
            data=data,
        )
        self._next_event_ids[conversation_id] += 1
        self._events[conversation_id].append(event)
        for subscriber in self._subscribers[conversation_id]:
            subscriber.put_nowait(event)
