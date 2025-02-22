# llm-wrapper-api

This project is a wrapper API for LLM built using FastAPI.

## Setup

This project uses VSCode's Dev Containers (via the Remote - Containers extension) for its development environment. 

You should have Docker Desktop (or Docker Engine) installed locally.


**Reopen in Container:**

1. Open the project in VSCode.
1. Open the VSCode command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type "Reopen in Container", then execute the command.
1.  VSCode will restart inside the container, setting up the development environment.


## Usage

**Start the Application:**

```bash
uvicorn main:app --reload --host 0.0.0.0
```

Open your browser and go to http://127.0.0.1:8000/docs
