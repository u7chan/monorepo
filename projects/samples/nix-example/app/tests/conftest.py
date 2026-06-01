"""
Test configuration and fixtures for the test suite.
"""

import io

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    """Create a test client for the FastAPI application."""
    return TestClient(app)


@pytest.fixture
def sample_requirements_file():
    """Create a sample requirements.txt file for testing."""
    content = "requests==2.31.0\nnumpy==1.24.3\n"
    return io.BytesIO(content.encode("utf-8"))


@pytest.fixture
def sample_code_file():
    """Create a sample Python code file for testing."""
    content = """
import requests
import numpy as np

print("Hello, World!")
print(f"Requests version: {requests.__version__}")
print(f"NumPy version: {np.__version__}")

result = np.array([1, 2, 3, 4, 5])
print(f"NumPy array: {result}")
print(f"Sum: {result.sum()}")
"""
    return io.BytesIO(content.encode("utf-8"))


@pytest.fixture
def empty_requirements_file():
    """Create an empty requirements.txt file for testing."""
    return io.BytesIO(b"")


@pytest.fixture
def empty_code_file():
    """Create an empty Python code file for testing."""
    return io.BytesIO(b"")


@pytest.fixture
def invalid_requirements_file():
    """Create an invalid requirements.txt file for testing."""
    content = b"\xff\xfe\x00\x00"  # Invalid UTF-8
    return io.BytesIO(content)
