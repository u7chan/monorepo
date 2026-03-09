"""Tests for API entry point wiring."""

from unittest.mock import MagicMock, patch

from simple_agent_poc.main_api import app, main


class TestMainAPI:
    """Tests for the API entry point."""

    def test_app_is_created(self) -> None:
        assert app is not None

    @patch("simple_agent_poc.main_api.uvicorn.run")
    def test_main_runs_uvicorn(self, mock_run: MagicMock) -> None:
        main()

        mock_run.assert_called_once_with(
            "simple_agent_poc.main_api:app",
            host="127.0.0.1",
            port=8000,
        )
