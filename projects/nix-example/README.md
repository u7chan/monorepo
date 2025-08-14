# Nix Python Executor

Safe Python code execution using Nix environments and Docker containers.

## Project Structure

```
.
├── app/
│   ├── __init__.py          # Package initialization
│   ├── main.py              # FastAPI application
│   └── models.py            # Pydantic data models
├── pyproject.toml          # Project configuration and dependencies
└── README.md               # This file
```

## Data Models

The system uses the following Pydantic models:

- **ExecutionRequest**: Request payload for code execution
- **ExecutionResult**: Response containing execution results
- **ContainerConfig**: Docker container configuration
- **ErrorResponse**: Standardized error responses

## Development

To run the development server:

```bash
# Install dependencies with uv
uv sync

# Run the development server
uv run uvicorn app.main:app --reload
```

## API Endpoints

- `GET /` - Health check
- `GET /health` - Detailed health check
- `POST /run` - Execute Python code (to be implemented)