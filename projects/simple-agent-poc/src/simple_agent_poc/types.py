from typing import Literal, TypedDict

type MessageRole = Literal["user", "assistant"]


class Message(TypedDict):
    role: MessageRole
    content: str
