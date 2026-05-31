"""
API router for code execution endpoints.
Handles file uploads and code execution requests.
"""

import time
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.models import ExecutionResult

router = APIRouter(prefix="/api/v1", tags=["execution"])


def _validate_file_types(requirements: UploadFile, code: UploadFile) -> None:
    """Validate that uploaded files have correct extensions."""
    if not requirements.filename or not requirements.filename.endswith(".txt"):
        raise HTTPException(
            status_code=400,
            detail="Requirements file must be a .txt file",
        )

    if not code.filename or not code.filename.endswith(".py"):
        raise HTTPException(
            status_code=400,
            detail="Code file must be a .py file",
        )


def _validate_file_contents(requirements_content: bytes, code_content: bytes) -> None:
    """Validate that file contents are not empty."""
    if not requirements_content.strip():
        raise HTTPException(
            status_code=400,
            detail="Requirements file cannot be empty",
        )

    if not code_content.strip():
        raise HTTPException(
            status_code=400,
            detail="Code file cannot be empty",
        )


@router.post("/run", response_model=ExecutionResult)
async def execute_code(
    requirements: UploadFile = File(..., description="requirements.txt file"),  # noqa: B008
    code: UploadFile = File(..., description="Python code file"),  # noqa: B008
) -> ExecutionResult:
    """
    Execute Python code in an isolated Nix environment.

    This endpoint accepts two files:
    - requirements.txt: Python package dependencies
    - main.py: Python code to execute

    The code is executed in a secure, isolated Docker container with:
    - No network access
    - Limited resource usage (512MB RAM, 0.5 CPU)
    - 10-second execution timeout
    - Non-root user execution

    Args:
        requirements: requirements.txt file containing Python dependencies
        code: Python code file to execute

    Returns:
        ExecutionResult: Results of code execution including stdout, stderr, and timing

    Raises:
        HTTPException: For various error conditions during file processing
    """
    try:
        # Validate file types
        _validate_file_types(requirements, code)

        # Read file contents
        try:
            requirements_content = await requirements.read()
            code_content = await code.read()
        except OSError as e:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to read uploaded files: {e!s}",
            ) from e

        # Validate file contents are not empty
        _validate_file_contents(requirements_content, code_content)

        # Decode file contents
        try:
            requirements_str = requirements_content.decode("utf-8")  # noqa: F841
            code_str = code_content.decode("utf-8")
        except UnicodeDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail="Files must be UTF-8 encoded",
            ) from e

        # TODO: Implement actual code execution logic with Docker container
        # This will be implemented in task 4 (temporary file management)
        # and task 7 (Docker integration)

        # For now, return a mock successful execution result
        execution_start = time.time()

        # Mock execution result
        return ExecutionResult(
            stdout="Hello, World!\nMock execution completed successfully",
            stderr="",
            return_code=0,
            execution_time=time.time() - execution_start,
            formatted_code=code_str,  # Will be replaced with ruff formatting
            lint_warnings=[],  # Will be populated by ruff linting
            success=True,
        )

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        # Handle unexpected errors
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {e!s}",
        ) from e


@router.get("/health")
async def health_check():
    """
    Health check endpoint for the execution service.

    Returns:
        dict: Service health status and version information
    """
    return {
        "status": "healthy",
        "service": "nix-python-executor",
        "version": "1.0.0",
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
    }
