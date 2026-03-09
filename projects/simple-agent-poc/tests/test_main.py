"""Tests for CLI entry point wiring."""

from unittest.mock import MagicMock, patch

from simple_agent_poc.entrypoints.main_cli import build_cli_adapter, main


class TestBuildCLIAdapter:
    """Tests for production CLI wiring."""

    @patch("simple_agent_poc.entrypoints.main_cli.CLIAdapter")
    def test_build_cli_adapter_wires_dependencies(
        self,
        mock_cli_adapter: MagicMock,
    ) -> None:
        with patch(
            "simple_agent_poc.entrypoints.main_cli.bootstrap.create_run_agent_use_case"
        ) as mock_create_run_agent_use_case:
            adapter = build_cli_adapter()

            assert adapter is mock_cli_adapter.return_value
            mock_create_run_agent_use_case.assert_called_once_with()
            mock_cli_adapter.assert_called_once_with(
                mock_create_run_agent_use_case.return_value
            )


class TestMain:
    """Tests for the CLI entry point."""

    @patch("simple_agent_poc.entrypoints.main_cli.build_cli_adapter")
    def test_main_runs_built_adapter(self, mock_build_cli_adapter: MagicMock) -> None:
        adapter = mock_build_cli_adapter.return_value

        main()

        mock_build_cli_adapter.assert_called_once_with()
        adapter.run.assert_called_once_with()
