# Nix Python Executor

Safe Python code execution using Nix environments and Docker containers.

## Project Structure

```
.
├── app/
│   ├── __init__.py          # Package initialization
│   ├── main.py              # FastAPI application
│   ├── models.py            # Pydantic data models
│   ├── routers/
│   │   ├── __init__.py      # Routers package
│   │   └── execution.py     # Code execution endpoints
│   └── tests/
│       ├── __init__.py      # Tests package
│       ├── conftest.py      # Test configuration and fixtures
│       ├── test_main.py     # Tests for main application
│       └── test_execution.py # Tests for execution endpoints
├── pyproject.toml          # Project configuration and dependencies
└── README.md               # This file
```

## Data Models

The system uses the following Pydantic models:

- **ExecutionRequest**: Request payload for code execution
- **ExecutionResult**: Response containing execution results
- **ContainerConfig**: Docker container configuration
- **ErrorResponse**: Standardized error responses

## API Endpoints

### Main Application

- `GET /` - Health check
- `GET /health` - Detailed health check

### Code Execution API (v1)

- `GET /api/v1/health` - API health check with timestamp
- `POST /api/v1/run` - Execute Python code in isolated environment

#### POST /api/v1/run

Execute Python code in an isolated Nix environment with Docker containers.

**Request**: Multipart form data with two files:

- `requirements` (file): requirements.txt file containing Python dependencies
- `code` (file): Python code file (.py) to execute

**Response**: JSON object with execution results:

```json
{
    "stdout": "string",
    "stderr": "string", 
    "return_code": 0,
    "execution_time": 0.1,
    "formatted_code": "string",
    "lint_warnings": [],
    "success": true
}
```

**Security Features**:

- Files are validated for correct extensions (.txt/.py)
- Content is validated for UTF-8 encoding
- Empty files are rejected
- All execution happens in isolated Docker containers

## Implementation Status

### ✅ Task 1: Project Structure and Data Models

- ✅ Project directory structure created
- ✅ FastAPI application base implemented
- ✅ Pydantic models for ExecutionRequest, ExecutionResult, ContainerConfig, ErrorResponse
- ✅ Type hints and field validation added

### ✅ Task 2: FastAPI Manager Basic Implementation  

- ✅ FastAPI application with routers created
- ✅ `/api/v1/run` endpoint with file upload functionality
- ✅ File validation (extensions, encoding, non-empty)
- ✅ Error handling with custom exception handlers
- ✅ Structured response format using ErrorResponse model
- ✅ Basic test suite for endpoints and file validation
- ✅ Mock execution results for development

### 🔄 Next Tasks

- Task 3: ruff code formatting and linting integration
- Task 4: Temporary file management system
- Task 5: Nix Worker Container Dockerfile
- Task 6: Worker Container execution scripts
- Task 7: Docker integration and container management

## Development

To run the development server:

```bash
# Install dependencies with uv
uv sync

# Run the development server
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

To run tests:

```bash
# Run all tests
uv run pytest app/tests/ -v

# Run with coverage
uv run pytest app/tests/ --cov=app --cov-report=html
```

## Testing the API

You can test the `/api/v1/run` endpoint with curl:

```bash
# Create test files
echo "requests==2.31.0" > requirements.txt
echo "import requests; print('Hello from Python!')" > main.py

# Test the endpoint
curl -X POST http://localhost:8000/api/v1/run \
  -F "requirements=@requirements.txt" \
  -F "code=@main.py"
```
