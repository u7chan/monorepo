"""
Tests for the execution router endpoints.
"""

from http import HTTPStatus
from io import BytesIO


def test_execute_code_success(client, sample_requirements_file, sample_code_file):
    """Test successful code execution with valid files."""
    response = client.post(
        "/api/v1/run",
        files={
            "requirements": (
                "requirements.txt",
                sample_requirements_file,
                "text/plain",
            ),
            "code": ("main.py", sample_code_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.OK
    data = response.json()

    # Check response structure
    assert "stdout" in data
    assert "stderr" in data
    assert "return_code" in data
    assert "execution_time" in data
    assert "formatted_code" in data
    assert "lint_warnings" in data
    assert "success" in data

    # Check mock execution results
    assert data["success"] is True
    assert data["return_code"] == 0
    assert "Mock execution completed successfully" in data["stdout"]


def test_execute_code_invalid_requirements_extension(client, sample_code_file):
    """Test that non-.txt requirements file is rejected."""
    invalid_file = BytesIO(b"requests==2.31.0")

    response = client.post(
        "/api/v1/run",
        files={
            "requirements": ("requirements.py", invalid_file, "text/plain"),
            "code": ("main.py", sample_code_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    data = response.json()
    assert "Requirements file must be a .txt file" in data["detail"]


def test_execute_code_invalid_code_extension(client, sample_requirements_file):
    """Test that non-.py code file is rejected."""
    invalid_file = BytesIO(b"print('hello')")

    response = client.post(
        "/api/v1/run",
        files={
            "requirements": (
                "requirements.txt",
                sample_requirements_file,
                "text/plain",
            ),
            "code": ("main.txt", invalid_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    data = response.json()
    assert "Code file must be a .py file" in data["detail"]


def test_execute_code_empty_requirements(client, sample_code_file):
    """Test that empty requirements file is rejected."""
    empty_file = BytesIO(b"   \n  \t  ")

    response = client.post(
        "/api/v1/run",
        files={
            "requirements": ("requirements.txt", empty_file, "text/plain"),
            "code": ("main.py", sample_code_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    data = response.json()
    assert "Requirements file cannot be empty" in data["detail"]


def test_execute_code_empty_code(client, sample_requirements_file):
    """Test that empty code file is rejected."""
    empty_file = BytesIO(b"   \n  \t  ")

    response = client.post(
        "/api/v1/run",
        files={
            "requirements": (
                "requirements.txt",
                sample_requirements_file,
                "text/plain",
            ),
            "code": ("main.py", empty_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    data = response.json()
    assert "Code file cannot be empty" in data["detail"]


def test_execute_code_invalid_utf8(client, sample_code_file):
    """Test that non-UTF-8 files are rejected."""
    invalid_utf8_file = BytesIO(b"\xff\xfe\x00\x00")

    response = client.post(
        "/api/v1/run",
        files={
            "requirements": ("requirements.txt", invalid_utf8_file, "text/plain"),
            "code": ("main.py", sample_code_file, "text/plain"),
        },
    )

    assert response.status_code == HTTPStatus.BAD_REQUEST
    data = response.json()
    assert "Files must be UTF-8 encoded" in data["detail"]
