"""
Main FastAPI application for Nix Python Executor.
Provides HTTP API for safe Python code execution in isolated containers.
"""

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.models import ErrorResponse
from app.routers import execution

# Create FastAPI application instance
app = FastAPI(
    title="Nix Python Executor",
    description=(
        "Safe Python code execution using Nix environments and Docker containers"
    ),
    version="1.0.0",
)

# Add CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(execution.router)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"message": "Nix Python Executor API is running"}


@app.get("/health")
async def health_check():
    """Detailed health check endpoint."""
    return {
        "status": "healthy",
        "service": "nix-python-executor",
        "version": "1.0.0",
    }


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Custom HTTP exception handler that returns ErrorResponse format."""
    _ = request  # Suppress unused variable warning
    error_response = ErrorResponse(
        error=f"HTTP {exc.status_code}",
        detail=exc.detail,
        error_code=f"HTTP_{exc.status_code}",
        timestamp=datetime.now(tz=timezone.utc).isoformat(),
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response.model_dump(),
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """General exception handler for unexpected errors."""
    _ = request  # Suppress unused variable warning
    error_response = ErrorResponse(
        error="Internal Server Error",
        detail=str(exc),
        error_code="INTERNAL_ERROR",
        timestamp=datetime.now(tz=timezone.utc).isoformat(),
    )
    return JSONResponse(
        status_code=500,
        content=error_response.model_dump(),
    )
