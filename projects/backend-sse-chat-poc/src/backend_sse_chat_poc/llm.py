from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Protocol, Sequence

from openai import AsyncOpenAI


class ChatStreamer(Protocol):
    async def stream_reply(
        self, messages: Sequence[dict[str, str]]
    ) -> AsyncIterator[str]: ...


class OpenAIChatStreamer:
    def __init__(
        self, *, api_key: str, model: str, base_url: str | None = None
    ) -> None:
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._model = model

    async def stream_reply(
        self, messages: Sequence[dict[str, str]]
    ) -> AsyncIterator[str]:
        stream = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {
                    "role": message["role"],
                    "content": message["content"],
                }
                for message in messages
            ],
            stream=True,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta


class FakeChatStreamer:
    def __init__(
        self,
        *,
        chunks: Sequence[str] | None = None,
        delay_seconds: float = 0.08,
        error_after_chunks: int | None = None,
        prefix: str = "Echo",
    ) -> None:
        self._chunks = list(chunks) if chunks is not None else None
        self._delay_seconds = delay_seconds
        self._error_after_chunks = error_after_chunks
        self._prefix = prefix

    async def stream_reply(
        self, messages: Sequence[dict[str, str]]
    ) -> AsyncIterator[str]:
        if self._chunks is None:
            last_user_message = next(
                (
                    message["content"]
                    for message in reversed(messages)
                    if message["role"] == "user"
                ),
                "",
            )
            payload = f"{self._prefix}: {last_user_message}".strip()
            chunks = _chunk_text(payload)
        else:
            chunks = self._chunks

        for index, chunk in enumerate(chunks, start=1):
            if self._delay_seconds > 0:
                await asyncio.sleep(self._delay_seconds)
            yield chunk
            if (
                self._error_after_chunks is not None
                and index >= self._error_after_chunks
            ):
                raise RuntimeError("fake upstream stream failed")


def build_default_streamer() -> ChatStreamer:
    backend = os.getenv("CHAT_BACKEND", "").strip().lower()
    if backend == "fake":
        return FakeChatStreamer(
            delay_seconds=float(os.getenv("FAKE_STREAM_DELAY_SECONDS", "0.08"))
        )

    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        return OpenAIChatStreamer(
            api_key=api_key,
            model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            base_url=os.getenv("OPENAI_BASE_URL") or None,
        )

    return FakeChatStreamer(
        delay_seconds=float(os.getenv("FAKE_STREAM_DELAY_SECONDS", "0.08"))
    )


def _chunk_text(payload: str, chunk_size: int = 12) -> list[str]:
    return [
        payload[index : index + chunk_size]
        for index in range(0, len(payload), chunk_size)
    ] or [""]
