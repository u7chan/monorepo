"""CLI entry point wiring."""

import argparse
from collections.abc import Sequence

from simple_agent_poc.adapters.cli.adapter import CLIAdapter
from simple_agent_poc.entrypoints import bootstrap


def build_cli_adapter(*, agent_id: str = bootstrap.DEFAULT_AGENT_ID) -> CLIAdapter:
    """Create the CLI adapter with production dependencies."""
    agent_definitions = bootstrap.create_agent_definition_registry()
    return CLIAdapter(
        bootstrap.create_run_agent_use_case(agent_definitions=agent_definitions),
        agent_id=agent_id,
        agent_definitions=agent_definitions,
    )


def main(argv: Sequence[str] | None = None) -> None:
    """Run the CLI entry point."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", default=bootstrap.DEFAULT_AGENT_ID)
    args = parser.parse_args(argv)

    adapter = build_cli_adapter(agent_id=args.agent)
    adapter.run()


if __name__ == "__main__":
    main()
