#!/usr/bin/env python3
"""Tests for the Dependabot configuration maintenance skill."""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "maintain-dependabot.py"
)
SPEC = importlib.util.spec_from_file_location("maintain_dependabot", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MAINTAIN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MAINTAIN
SPEC.loader.exec_module(MAINTAIN)


class MaintainDependabotTests(unittest.TestCase):
    def test_pnpm_lockfile_is_detected_as_npm(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            (project_dir / "pnpm-lock.yaml").touch()

            self.assertEqual(MAINTAIN.detect_ecosystem(project_dir), "npm")

    def test_bun_is_prioritized_over_pnpm(self) -> None:
        for lockfile in ("bun.lock", "bun.lockb"):
            with self.subTest(lockfile=lockfile):
                with tempfile.TemporaryDirectory() as temp_dir:
                    project_dir = Path(temp_dir)
                    (project_dir / lockfile).touch()
                    (project_dir / "pnpm-lock.yaml").touch()

                    self.assertEqual(
                        MAINTAIN.detect_ecosystem(project_dir), "bun"
                    )

    def test_uv_and_missing_lockfiles_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            (project_dir / "uv.lock").touch()
            self.assertEqual(MAINTAIN.detect_ecosystem(project_dir), "uv")

        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertIsNone(MAINTAIN.detect_ecosystem(Path(temp_dir)))

    def test_scan_projects_excludes_lab_and_sample_categories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            projects = Path(temp_dir)
            fixtures = (
                ("main-project", "pnpm-lock.yaml"),
                # Category directories stay excluded even when the directory
                # itself looks like a project to lockfile-based detection.
                ("_labs", "pnpm-lock.yaml"),
                ("_labs/lab-project", "pnpm-lock.yaml"),
                ("_samples", "bun.lock"),
                ("_samples/sample-project", "bun.lock"),
                ("main-project/client", "package-lock.json"),
            )
            for relative_dir, lockfile in fixtures:
                project_dir = projects / relative_dir
                project_dir.mkdir(parents=True)
                (project_dir / lockfile).touch()

            self.assertEqual(
                MAINTAIN.scan_projects(projects),
                {"/projects/main-project": "npm"},
            )

    def test_new_entry_contains_required_label(self) -> None:
        block = MAINTAIN.build_new_block("bun", "/projects/example")
        entry = MAINTAIN._entry_from_block(block)

        self.assertEqual(entry["labels"], ["dependabot-auto-process"])

    def test_existing_labels_are_preserved_and_required_label_is_added(self) -> None:
        block = [
            '  - package-ecosystem: "bun"',
            '    directory: "/projects/example"',
            "    labels:",
            '      - "dependencies"',
            "    groups:",
            "      example-minor-and-patch:",
            "        patterns:",
            '          - "*"',
        ]

        normalized = MAINTAIN.normalize_block(
            block, "bun", "/projects/example"
        )
        entry = MAINTAIN._entry_from_block(normalized)

        self.assertEqual(
            entry["labels"], ["dependencies", "dependabot-auto-process"]
        )

    def test_inline_labels_are_expanded_without_losing_existing_values(self) -> None:
        block = [
            '  - package-ecosystem: "bun"',
            '    directory: "/projects/example"',
            '    labels: ["dependencies", "javascript"]',
            "    groups:",
            "      example-minor-and-patch:",
            '        patterns: ["*"]',
        ]

        normalized = MAINTAIN.normalize_block(
            block, "bun", "/projects/example"
        )
        entry = MAINTAIN._entry_from_block(normalized)

        self.assertEqual(
            entry["labels"],
            ["dependencies", "javascript", "dependabot-auto-process"],
        )

    def test_coverage_validation_detects_missing_required_label(self) -> None:
        config = yaml.safe_load(
            """
            version: 2
            updates:
              - package-ecosystem: bun
                directory: /projects/example
                labels:
                  - dependencies
            """
        )

        with self.assertRaisesRegex(ValueError, "missing required label"):
            MAINTAIN.validate_coverage(config, {"/projects/example": "bun"})

    def test_coverage_validation_accepts_one_labeled_entry_per_project(self) -> None:
        config = yaml.safe_load(
            """
            version: 2
            updates:
              - package-ecosystem: bun
                directory: /projects/example
                labels:
                  - dependabot-auto-process
            """
        )

        MAINTAIN.validate_coverage(config, {"/projects/example": "bun"})


if __name__ == "__main__":
    unittest.main()
