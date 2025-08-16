"""
Tests for the main FastAPI application.
"""

from http import HTTPStatus


def test_root_endpoint(client):
    """Test the root endpoint returns expected message."""
    response = client.get("/")
    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"message": "Nix Python Executor API is running"}


def test_health_endpoint(client):
    """Test the health check endpoint returns expected status."""
    response = client.get("/health")
    assert response.status_code == HTTPStatus.OK
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "nix-python-executor"
    assert data["version"] == "1.0.0"


def test_api_health_endpoint(client):
    """Test the API health check endpoint returns expected status."""
    response = client.get("/api/v1/health")
    assert response.status_code == HTTPStatus.OK
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "nix-python-executor"
    assert data["version"] == "1.0.0"
    assert "timestamp" in data
