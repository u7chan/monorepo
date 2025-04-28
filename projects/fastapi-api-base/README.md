# fastapi-api-base

This project is a development platform for FastAPI.

## Setup

This project uses VSCode's Dev Containers (via the Remote - Containers extension) for its development environment.

You should have Docker Desktop (or Docker Engine) installed locally.

**Reopen in Container:**

1. Open the project in VSCode.
1. Open the VSCode command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type "Reopen in Container", then execute the command.
1. VSCode will restart inside the container, setting up the development environment.

## Usage

1. **Start the Application:** You can start the FastAPI application in two ways:

   a. **Using the command line:**

   ```bash
   uvicorn src.main:app --reload --host 0.0.0.0
   ```

   b. **Using VSCode Run & Debug:**

   1. Open the project in VSCode.
   1. Go to the Run and Debug view (Ctrl+Shift+D or Cmd+Shift+D).
   1. Select the "FastAPI" configuration (or the name you gave to your launch configuration).
   1. Press F5 to start the application. This will use the settings defined in your `launch.json` file.

1. **API Documentation:** Open your browser and go to http://127.0.0.1:8000/docs to view the API documentation with Swagger UI.
