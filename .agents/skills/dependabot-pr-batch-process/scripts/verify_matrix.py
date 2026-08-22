#!/usr/bin/env python3
"""Validate the Dependabot project verification matrix from repository root."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from batch_process import VerificationMatrix, validate_repository_matrix


DEFAULT_MATRIX = Path(".agents/skills/dependabot-pr-batch-process/verification-matrix.json")
DEFAULT_DEPENDABOT = Path(".github/dependabot.yml")


def load_matrix(path: Path) -> VerificationMatrix:
    return VerificationMatrix.from_mapping(json.loads(path.read_text(encoding="utf-8")))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--dependabot-config", type=Path, default=DEFAULT_DEPENDABOT)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    matrix = load_matrix(args.matrix)
    errors = validate_repository_matrix(
        matrix,
        repository_root=args.root,
        dependabot_config=args.dependabot_config,
    )
    if errors:
        for error in errors:
            print(f"ERROR {error}")
        return 1
    print(
        f"matrix OK: projects={len(matrix.projects)} "
        f"docker_max_concurrency={matrix.max_docker_concurrency}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
