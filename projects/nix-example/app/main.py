"""
Main FastAPI application for Nix Python Executor.
Provides HTTP API for safe Python code execution in isolated containers.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.models import ExecutionResult, ErrorResponse

# Create FastAPI application instance
app = FastAPI(
    title="Nix Python Executor",
    description="Safe Python code execution using Nix environments and Docker containers",
    version="1.0.0"
)

# Add CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        "version": "1.0.0"
    }