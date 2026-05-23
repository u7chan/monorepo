from typing import Annotated

from fastapi import FastAPI, Query, status
from pydantic import BaseModel, Field


class MemoCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=1000)


class Memo(BaseModel):
    id: int
    title: str
    body: str


class HealthResponse(BaseModel):
    status: str


app = FastAPI(title="AI Driven Dev Memo API")

_memos: list[Memo] = []
_next_id = 1


def reset_store() -> None:
    global _next_id

    _memos.clear()
    _next_id = 1


def matches(memo: Memo, query: str) -> bool:
    normalized_query = query.lower()
    return normalized_query in memo.title.lower() or normalized_query in memo.body.lower()


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/memos", status_code=status.HTTP_201_CREATED)
def create_memo(payload: MemoCreate) -> Memo:
    global _next_id

    memo = Memo(id=_next_id, title=payload.title, body=payload.body)
    _memos.append(memo)
    _next_id += 1
    return memo


@app.get("/memos")
def list_memos() -> list[Memo]:
    return list(_memos)


@app.get("/memos/search")
def search_memos(q: Annotated[str, Query(min_length=1)]) -> list[Memo]:
    return [memo for memo in _memos if matches(memo, q)]
