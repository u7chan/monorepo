#!/usr/bin/env python3
"""Negative tests for matrix safety and repository coverage."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("batch_process_matrix", SCRIPT_DIR / "batch_process.py")
assert SPEC and SPEC.loader
matrix_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = matrix_module
SPEC.loader.exec_module(matrix_module)


def base_matrix(project_name: str = "example") -> dict:
    return {
        "version": 1,
        "docker": {"max_concurrency": 2, "default_timeout_seconds": 60},
        "projects": {
            project_name: {
                "path": f"projects/{project_name}",
                "ecosystem": "bun",
                "checks": [
                    {"id": "test", "kind": "test", "required": True, "argv": ["bun", "test"], "timeout_seconds": 60},
                    {"id": "lint", "kind": "lint", "required": True, "argv": ["bun", "run", "lint"], "timeout_seconds": 60},
                    {"id": "typecheck", "kind": "typecheck", "required": True, "argv": ["bunx", "tsc", "--noEmit"], "timeout_seconds": 60},
                    {"id": "license", "kind": "license", "required": True, "argv": ["license"], "timeout_seconds": 60},
                ],
                "docker": {
                    "test": {"target": "test", "required": True, "timeout_seconds": 60},
                    "final": {"target": "final", "required": True, "timeout_seconds": 60},
                },
            }
        },
    }


class MatrixNegativeTests(unittest.TestCase):
    def test_concurrency_above_two_is_rejected(self) -> None:
        raw = base_matrix()
        raw["docker"]["max_concurrency"] = 3
        with self.assertRaises(matrix_module.MatrixError):
            matrix_module.VerificationMatrix.from_mapping(raw)

    def test_required_check_without_command_is_rejected(self) -> None:
        raw = base_matrix()
        raw["projects"]["example"]["checks"][0]["argv"] = []
        with self.assertRaises(matrix_module.MatrixError):
            matrix_module.VerificationMatrix.from_mapping(raw)

    def test_secret_and_host_mount_flags_are_rejected_but_pytest_v_is_not(self) -> None:
        raw = base_matrix()
        raw["projects"]["example"]["checks"][0]["argv"] = ["docker", "build", "--mount", "x"]
        with self.assertRaises(matrix_module.MatrixError):
            matrix_module.VerificationMatrix.from_mapping(raw)
        raw = base_matrix()
        raw["projects"]["example"]["checks"][0]["argv"] = ["pytest", "-v"]
        matrix_module.VerificationMatrix.from_mapping(raw)

    def test_repository_coverage_detects_missing_and_extra_projects(self) -> None:
        raw = base_matrix()
        matrix = matrix_module.VerificationMatrix.from_mapping(raw)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "projects/example").mkdir(parents=True)
            (root / "projects/example/package.json").write_text("{}\n", encoding="utf-8")
            (root / "projects/example/bun.lock").write_text("\n", encoding="utf-8")
            (root / "projects/example/Dockerfile").write_text(
                "FROM alpine AS test\nFROM alpine AS final\n", encoding="utf-8"
            )
            config = root / "dependabot.yml"
            config.write_text(
                'updates:\n  - package-ecosystem: "bun"\n    directory: "/projects/example"\n  - package-ecosystem: "bun"\n    directory: "/projects/extra"\n',
                encoding="utf-8",
            )
            errors = matrix_module.validate_repository_matrix(
                matrix, repository_root=root, dependabot_config=config
            )
        self.assertTrue(any("coverage mismatch" in error for error in errors))

    def test_docker_command_has_no_normal_build_fallback(self) -> None:
        raw = base_matrix()
        raw["projects"]["example"]["docker"]["test"]["required"] = False
        matrix = matrix_module.VerificationMatrix.from_mapping(raw)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "projects/example"
            project.mkdir(parents=True)
            (project / "Dockerfile").write_text("FROM alpine AS final\n", encoding="utf-8")
            specs = matrix_module.docker_specs_for_project(
                matrix, "example", repository_root=root, commit_sha="a" * 40
            )
        self.assertEqual([spec.stage for spec in specs], ["final"])
        self.assertNotIn("docker build", [" ".join(spec.argv()) for spec in specs])


if __name__ == "__main__":
    unittest.main()
