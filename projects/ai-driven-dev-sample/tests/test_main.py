import pytest
from fastapi.testclient import TestClient

from src.main import app, reset_store


@pytest.fixture(autouse=True)
def reset_memos():
    reset_store()


@pytest.fixture
def client():
    return TestClient(app)


def test_health_returns_ok(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_memo_returns_memo_with_id(client):
    response = client.post(
        "/memos",
        json={
            "title": "AI driven development note",
            "body": "Write requirements first, then tests.",
        },
    )

    assert response.status_code == 201
    assert response.json() == {
        "id": 1,
        "title": "AI driven development note",
        "body": "Write requirements first, then tests.",
    }


def test_list_memos_returns_created_memos(client):
    client.post("/memos", json={"title": "First note", "body": "Testing comes first."})
    client.post("/memos", json={"title": "Second note", "body": "Implement after tests."})

    response = client.get("/memos")

    assert response.status_code == 200
    assert response.json() == [
        {"id": 1, "title": "First note", "body": "Testing comes first."},
        {"id": 2, "title": "Second note", "body": "Implement after tests."},
    ]


def test_search_memos_matches_title_and_body_partially(client):
    client.post("/memos", json={"title": "FastAPI test memo", "body": "Use TestClient."})
    client.post("/memos", json={"title": "Planning memo", "body": "Write acceptance tests."})
    client.post("/memos", json={"title": "Deploy note", "body": "No search keyword here."})

    response = client.get("/memos/search", params={"q": "test"})

    assert response.status_code == 200
    assert response.json() == [
        {"id": 1, "title": "FastAPI test memo", "body": "Use TestClient."},
        {"id": 2, "title": "Planning memo", "body": "Write acceptance tests."},
    ]


def test_search_memos_is_case_insensitive(client):
    client.post("/memos", json={"title": "FastAPI Memo", "body": "Use TestClient."})

    response = client.get("/memos/search", params={"q": "fastapi"})

    assert response.status_code == 200
    assert response.json() == [
        {"id": 1, "title": "FastAPI Memo", "body": "Use TestClient."},
    ]


def test_search_requires_non_empty_query(client):
    response = client.get("/memos/search", params={"q": ""})

    assert response.status_code == 422


def test_store_is_reset_between_tests(client):
    response = client.get("/memos")

    assert response.status_code == 200
    assert response.json() == []
