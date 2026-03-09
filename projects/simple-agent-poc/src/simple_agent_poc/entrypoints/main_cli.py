"""CLI entry point wiring."""

from simple_agent_poc.adapters.cli.adapter import CLIAdapter
from simple_agent_poc.entrypoints import bootstrap

DEFAULT_MODEL = bootstrap.DEFAULT_MODEL


def build_cli_adapter() -> CLIAdapter:
    """Create the CLI adapter with production dependencies."""
    return CLIAdapter(bootstrap.create_run_agent_use_case())


def main() -> None:
    """Run the CLI entry point."""
    adapter = build_cli_adapter()
    adapter.run()


if __name__ == "__main__":
    main()
