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
        with (
            patch(
                "simple_agent_poc.entrypoints.main_cli.bootstrap.create_run_agent_use_case"
            ) as mock_create_run_agent_use_case,
            patch(
                "simple_agent_poc.entrypoints.main_cli.bootstrap.create_agent_definition_registry"
            ) as mock_create_registry,
        ):
            adapter = build_cli_adapter()

            assert adapter is mock_cli_adapter.return_value
            mock_create_registry.assert_called_once_with()
            mock_create_run_agent_use_case.assert_called_once_with(
                agent_definitions=mock_create_registry.return_value,
            )
            mock_cli_adapter.assert_called_once_with(
                mock_create_run_agent_use_case.return_value,
                agent_id="default",
            )

    @patch("simple_agent_poc.entrypoints.main_cli.CLIAdapter")
    def test_build_cli_adapter_passes_agent_id(
        self,
        mock_cli_adapter: MagicMock,
    ) -> None:
        with (
            patch(
                "simple_agent_poc.entrypoints.main_cli.bootstrap.create_run_agent_use_case"
            ),
            patch(
                "simple_agent_poc.entrypoints.main_cli.bootstrap.create_agent_definition_registry"
            ),
        ):
            build_cli_adapter(agent_id="researcher")

            mock_cli_adapter.assert_called_once()
            assert mock_cli_adapter.call_args.kwargs["agent_id"] == "researcher"


class TestMain:
    """Tests for the CLI entry point."""

    @patch("simple_agent_poc.entrypoints.main_cli.build_cli_adapter")
    def test_main_runs_built_adapter(self, mock_build_cli_adapter: MagicMock) -> None:
        adapter = mock_build_cli_adapter.return_value

        main([])

        mock_build_cli_adapter.assert_called_once_with(agent_id="default")
        adapter.run.assert_called_once_with()

    @patch("simple_agent_poc.entrypoints.main_cli.build_cli_adapter")
    def test_main_accepts_agent_argument(
        self, mock_build_cli_adapter: MagicMock
    ) -> None:
        adapter = mock_build_cli_adapter.return_value

        main(["--agent", "researcher"])

        mock_build_cli_adapter.assert_called_once_with(agent_id="researcher")
        adapter.run.assert_called_once_with()
