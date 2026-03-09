"""HTTP API entry point wiring."""

import uvicorn

from simple_agent_poc.adapters.http.api import create_app

app = create_app()


def main() -> None:
    """Run the HTTP API entry point."""
    uvicorn.run("simple_agent_poc.entrypoints.main_api:app", host="127.0.0.1", port=8000)
