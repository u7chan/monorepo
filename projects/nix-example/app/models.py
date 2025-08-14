"""
Data models for the Nix Python Executor system.
Implements Pydantic models for request/response handling and configuration.
"""

from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class ExecutionRequest(BaseModel):
    """Request model for Python code execution."""
    requirements_content: str = Field(
        ..., 
        description="Contents of requirements.txt file",
        min_length=1
    )
    code_content: str = Field(
        ..., 
        description="Python code to execute",
        min_length=1
    )
    timeout: Optional[int] = Field(
        default=10,
        description="Execution timeout in seconds",
        ge=1,
        le=60
    )
    format_code: Optional[bool] = Field(
        default=True,
        description="Whether to format code with ruff"
    )
    lint_code: Optional[bool] = Field(
        default=True,
        description="Whether to lint code with ruff"
    )


class ExecutionResult(BaseModel):
    """Response model for Python code execution results."""
    stdout: str = Field(
        default="",
        description="Standard output from code execution"
    )
    stderr: str = Field(
        default="",
        description="Standard error output from code execution"
    )
    return_code: int = Field(
        ...,
        description="Exit code from code execution"
    )
    execution_time: float = Field(
        ...,
        description="Execution time in seconds",
        ge=0
    )
    formatted_code: Optional[str] = Field(
        default=None,
        description="Code after ruff formatting"
    )
    lint_warnings: Optional[List[str]] = Field(
        default=None,
        description="Warnings from ruff linting"
    )
    success: bool = Field(
        ...,
        description="Whether execution completed successfully"
    )


class ContainerConfig(BaseModel):
    """Configuration for Docker container execution."""
    image: str = Field(
        default="nix-python-worker",
        description="Docker image name for worker container"
    )
    timeout: int = Field(
        default=10,
        description="Container execution timeout in seconds",
        ge=1,
        le=60
    )
    memory_limit: str = Field(
        default="512m",
        description="Memory limit for container"
    )
    cpu_limit: str = Field(
        default="0.5",
        description="CPU limit for container"
    )
    network_mode: str = Field(
        default="none",
        description="Network mode for container security"
    )
    user: str = Field(
        default="1000:1000",
        description="User ID for non-root execution"
    )


class ErrorResponse(BaseModel):
    """Error response model for API errors."""
    error: str = Field(
        ...,
        description="Error message"
    )
    detail: str = Field(
        ...,
        description="Detailed error description"
    )
    error_code: str = Field(
        ...,
        description="Error code for categorization"
    )
    timestamp: datetime = Field(
        default_factory=datetime.now,
        description="Error occurrence timestamp"
    )