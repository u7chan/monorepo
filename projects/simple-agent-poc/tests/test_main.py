"""Tests for CLI entry point wiring."""

from unittest.mock import MagicMock, patch

from simple_agent_poc.main import DEFAULT_MODEL, build_cli_adapter, main


class TestBuildCLIAdapter:
    """Tests for production CLI wiring."""

    @patch("simple_agent_poc.main.CLIAdapter")
    @patch("simple_agent_poc.main.RunAgentUseCase")
    @patch("simple_agent_poc.main.Agent")
    @patch("simple_agent_poc.main.datetime")
    def test_build_cli_adapter_wires_dependencies(
        self,
        mock_datetime: MagicMock,
        mock_agent: MagicMock,
        mock_use_case: MagicMock,
        mock_cli_adapter: MagicMock,
    ) -> None:
        mock_datetime.now.return_value.isoformat.return_value = "2026-03-09T12:00:00"

        adapter = build_cli_adapter()

        assert adapter is mock_cli_adapter.return_value
        mock_agent.assert_called_once()
        assert mock_agent.call_args.kwargs["model"] == DEFAULT_MODEL
        assert "2026-03-09T12:00:00" in mock_agent.call_args.kwargs["system_prompt"]
        mock_use_case.assert_called_once_with(mock_agent.return_value)
        mock_cli_adapter.assert_called_once_with(mock_use_case.return_value)


class TestMain:
    """Tests for the CLI entry point."""

    @patch("simple_agent_poc.main.build_cli_adapter")
    def test_main_runs_built_adapter(self, mock_build_cli_adapter: MagicMock) -> None:
        adapter = mock_build_cli_adapter.return_value

        main()

        mock_build_cli_adapter.assert_called_once_with()
        adapter.run.assert_called_once_with()
