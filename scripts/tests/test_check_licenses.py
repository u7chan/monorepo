from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "check_licenses.py"
SPEC = importlib.util.spec_from_file_location("check_licenses", MODULE_PATH)
check_licenses = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["check_licenses"] = check_licenses
SPEC.loader.exec_module(check_licenses)


POLICY = {
    "allowed": [
        "MIT",
        "Apache-2.0",
        "BSD-*",
        "ISC",
        "0BSD",
        "Unlicense",
        "Python-2.0",
        "BlueOak-*",
        "MPL-2.0",
    ],
    "review": ["LGPL-*", "MPL-1.*", "EPL-*", "CDDL-*"],
    "denied": ["AGPL-*", "GPL-*", "SSPL-*", "Commons Clause"],
    "overrides": [],
}


class PolicyValidationTest(unittest.TestCase):
    def test_repository_policy_mpl_classification(self) -> None:
        policy_path = MODULE_PATH.with_name("license-policy.json")
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        self.assertEqual(check_licenses.validate_policy(policy), [])
        cases = {
            "MPL-2.0": ("PASS", "LICENSE_ALLOWED"),
            "MPL-1.0": ("WARN", "LICENSE_REVIEW_REQUIRED"),
            "MPL-1.1": ("WARN", "LICENSE_REVIEW_REQUIRED"),
            "MIT AND MPL-2.0": ("PASS", "LICENSE_ALLOWED"),
            "MPL-2.0 AND GPL-3.0-only": ("FAIL", "LICENSE_DENIED"),
            "MPL-2.0 AND EPL-2.0": ("WARN", "LICENSE_REVIEW_REQUIRED"),
        }
        for expression, expected in cases.items():
            with self.subTest(expression=expression):
                package = check_licenses.PackageInfo("npm", "example", "1.0.0", expression)
                self.assertEqual(check_licenses.classify_license(policy, package), expected)

    def test_valid_policy_passes(self) -> None:
        self.assertEqual(check_licenses.validate_policy(POLICY), [])

    def test_override_requires_reason_and_reviewed_at(self) -> None:
        policy = {
            **POLICY,
            "overrides": [{"ecosystem": "npm", "name": "example", "status": "allowed"}],
        }
        errors = check_licenses.validate_policy(policy)
        self.assertIn("overrides[0].reason is required", errors)
        self.assertIn("overrides[0].reviewed_at is required", errors)

    def test_policy_validation_reports_list_and_override_errors_together(self) -> None:
        policy = {
            **POLICY,
            "allowed": "MIT",
            "overrides": [{"ecosystem": "npm", "name": "example", "status": "allowed"}],
        }
        errors = check_licenses.validate_policy(policy)
        self.assertIn("allowed must be a list of strings", errors)
        self.assertIn("overrides[0].reason is required", errors)


class LicenseExpressionTest(unittest.TestCase):
    def classify(self, expression: str | None) -> tuple[str, str]:
        package = check_licenses.PackageInfo("npm", "example", "1.0.0", expression)
        return check_licenses.classify_license(POLICY, package)

    def test_allowed_or_allowed_passes(self) -> None:
        self.assertEqual(self.classify("MIT OR Apache-2.0"), ("PASS", "LICENSE_ALLOWED"))

    def test_denied_or_allowed_passes(self) -> None:
        self.assertEqual(self.classify("GPL-2.0-only OR MIT"), ("PASS", "LICENSE_ALLOWED"))

    def test_allowed_and_allowed_passes(self) -> None:
        self.assertEqual(self.classify("MIT AND BSD-3-Clause"), ("PASS", "LICENSE_ALLOWED"))

    def test_allowed_wildcard_license_passes(self) -> None:
        self.assertEqual(self.classify("BSD-*"), ("PASS", "LICENSE_ALLOWED"))

    def test_mpl_2_0_is_allowed(self) -> None:
        self.assertEqual(self.classify("MPL-2.0"), ("PASS", "LICENSE_ALLOWED"))

    def test_allowed_and_review_warns(self) -> None:
        self.assertEqual(self.classify("MIT AND EPL-2.0"), ("WARN", "LICENSE_REVIEW_REQUIRED"))

    def test_mpl_1_1_requires_review(self) -> None:
        self.assertEqual(self.classify("MPL-1.1"), ("WARN", "LICENSE_REVIEW_REQUIRED"))

    def test_allowed_and_denied_fails(self) -> None:
        self.assertEqual(self.classify("MIT AND AGPL-3.0-only"), ("FAIL", "LICENSE_DENIED"))

    def test_spdx_or_has_lower_precedence_than_and(self) -> None:
        self.assertEqual(self.classify("AGPL-3.0-only AND MPL-2.0 OR MIT"), ("PASS", "LICENSE_ALLOWED"))

    def test_unknown_warns(self) -> None:
        self.assertEqual(self.classify("UNKNOWN"), ("WARN", "LICENSE_UNKNOWN"))

    def test_missing_license_warns(self) -> None:
        self.assertEqual(self.classify(None), ("WARN", "LICENSE_UNKNOWN"))

    def test_unsupported_expression_warns(self) -> None:
        self.assertEqual(self.classify("MIT / Apache-2.0"), ("WARN", "EXPRESSION_UNSUPPORTED"))


class PnpmWorkspaceTargetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "projects" / "_labs" / "example"
        self.child = self.workspace / "client"
        self.child.mkdir(parents=True)
        (self.workspace / "package.json").write_text('{"private":true}')
        (self.child / "package.json").write_text('{"dependencies":{"react":"19.2.0"}}')
        (self.workspace / "pnpm-workspace.yaml").write_text("packages:\n  - client\n")
        (self.workspace / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\nimporters:\n  .: {}\n  client:\n    dependencies: {}\npackages: {}\n")
        patcher = mock.patch.object(check_licenses, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_child_and_cli_targets_are_grouped_and_deduplicated(self) -> None:
        self.assertEqual(check_licenses.resolve_node_target(self.child), self.workspace)
        args = check_licenses.build_parser().parse_args(["--targets", f"{self.child},{self.workspace}"])
        self.assertEqual(check_licenses.parse_targets(args), [self.workspace])
        self.assertEqual(check_licenses.discover_all_targets(), [self.workspace])

    def test_independent_lockfile_and_nonmember_are_not_grouped(self) -> None:
        for lock in ("package-lock.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"):
            with self.subTest(lock=lock):
                (self.child / lock).write_text("{}")
                self.assertEqual(check_licenses.resolve_node_target(self.child), self.child)
                (self.child / lock).unlink()
        self.assertEqual(check_licenses.resolve_node_target(self.workspace / "unregistered"), self.workspace / "unregistered")

    def test_quoted_importers_and_deleted_manifest_are_grouped(self) -> None:
        (self.child / "package.json").unlink()
        for key in ("'client'", '"client"'):
            with self.subTest(key=key):
                (self.workspace / "pnpm-lock.yaml").write_text(f"importers:\n  {key}:\n    dependencies: {{}}\npackages:\n")
                self.assertEqual(check_licenses.resolve_node_target(self.child), self.workspace)

    def test_python_target_is_not_grouped(self) -> None:
        (self.child / "pyproject.toml").write_text("[project]\nname='example'\n")
        self.assertEqual(check_licenses.resolve_node_target(self.child), self.child)

    def test_missing_workspace_marker_is_not_grouped(self) -> None:
        (self.workspace / "pnpm-workspace.yaml").unlink()
        self.assertEqual(check_licenses.resolve_node_target(self.child), self.child)

    def test_workspace_with_another_manager_is_not_grouped(self) -> None:
        (self.workspace / "bun.lock").write_text("{}")
        self.assertEqual(check_licenses.resolve_node_target(self.child), self.child)

    def test_package_keys_outside_importers_do_not_match(self) -> None:
        (self.workspace / "pnpm-lock.yaml").write_text("importers:\n  .: {}\npackages:\n  client:\n    version: 1\n")
        self.assertEqual(check_licenses.resolve_node_target(self.child), self.child)

    def test_action_groups_changed_and_deleted_child_and_workspace_config(self) -> None:
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copyfile(MODULE_PATH, scripts / "check_licenses.py")
        action = MODULE_PATH.parents[1] / ".github/actions/get-license-check-targets/get-license-check-targets.sh"

        def git(*args: str) -> None:
            subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args], cwd=self.root, check=True, capture_output=True)

        git("init")
        git("add", ".")
        git("commit", "-m", "fixture")
        env = {key: value for key, value in os.environ.items() if key not in ("GITHUB_BASE_REF", "GITHUB_ENV")}
        for change in ("child", "deleted", "workspace"):
            with self.subTest(change=change):
                if change == "child":
                    (self.child / "package.json").write_text('{"dependencies":{"react":"19.2.1"}}')
                elif change == "deleted":
                    (self.child / "package.json").unlink()
                else:
                    (self.workspace / "pnpm-workspace.yaml").write_text("packages:\n  - 'client'\n")
                git("add", "projects")
                git("commit", "-m", change)
                result = subprocess.run(["bash", str(action)], cwd=self.root, env=env, text=True, capture_output=True, check=True)
                self.assertEqual((self.root / "license_check_targets.txt").read_text().strip(), "projects/_labs/example")
                self.assertIn("LICENSE_CHECK_PNPM_REQUIRED: true", result.stdout)


class TargetDetectionTest(unittest.TestCase):
    def test_dependency_free_package_json_does_not_require_lockfile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"scripts":{"test":"bun test"}}\n', encoding="utf-8")
            self.assertEqual(check_licenses.detect_target_managers(target), [("node-empty", None)])

            summary = check_licenses.check_target(target, POLICY)
            self.assertEqual(summary.packages_checked, 0)
            self.assertEqual(summary.fail_count, 0)
            self.assertEqual([(item.status, item.reason_code) for item in summary.items], [("PASS", "NO_DEPENDENCIES")])

    def test_empty_dependency_fields_do_not_require_lockfile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text(
                (
                    "{"
                    '"dependencies":{},'
                    '"devDependencies":{},'
                    '"optionalDependencies":{},'
                    '"peerDependencies":{}'
                    "}\n"
                ),
                encoding="utf-8",
            )
            self.assertEqual(check_licenses.detect_target_managers(target), [("node-empty", None)])

    def test_dependency_free_package_json_with_supported_lockfile_uses_current_manager(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"scripts":{"test":"bun test"}}\n', encoding="utf-8")
            (target / "package-lock.json").write_text("{}\n", encoding="utf-8")
            self.assertEqual(check_licenses.detect_target_managers(target), [("npm", None)])

    def test_pnpm_lockfile_uses_pnpm_manager(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"dependencies":{"left-pad":"1.3.0"}}\n', encoding="utf-8")
            (target / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
            self.assertEqual(check_licenses.detect_target_managers(target), [("pnpm", None)])

    def test_package_json_with_dependency_still_requires_supported_lockfile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"dependencies":{"left-pad":"1.3.0"}}\n', encoding="utf-8")
            self.assertEqual(
                check_licenses.detect_target_managers(target),
                [("node", "missing supported lockfile")],
            )

    def test_dependency_free_package_json_with_unsupported_lockfile_is_not_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"scripts":{"test":"bun test"}}\n', encoding="utf-8")
            (target / "yarn.lock").write_text("", encoding="utf-8")
            self.assertEqual(
                check_licenses.detect_target_managers(target),
                [("node", "unsupported lockfile: yarn.lock")],
            )

    def test_yarn_is_not_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"dependencies":{"left-pad":"1.3.0"}}\n', encoding="utf-8")
            (target / "yarn.lock").write_text("", encoding="utf-8")
            self.assertEqual(
                check_licenses.detect_target_managers(target),
                [("node", "unsupported lockfile: yarn.lock")],
            )

    def test_requirements_txt_without_uv_is_not_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "pyproject.toml").write_text("[project]\nname='example'\nversion='0.1.0'\n", encoding="utf-8")
            (target / "requirements.txt").write_text("requests==2.32.0\n", encoding="utf-8")
            self.assertEqual(
                check_licenses.detect_target_managers(target),
                [("python", "unsupported dependency file: requirements.txt")],
            )

    def test_nested_node_modules_package_root_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_modules = Path(tmp) / "node_modules"
            package_json = node_modules / "parent" / "node_modules" / "@scope" / "child" / "package.json"
            package_json.parent.mkdir(parents=True)
            package_json.write_text('{"name":"@scope/child","version":"1.0.0","license":"MIT"}\n', encoding="utf-8")

            internal = node_modules / "parent" / "dist" / "package.json"
            internal.parent.mkdir(parents=True)
            internal.write_text('{"name":"not-a-package-root","version":"1.0.0"}\n', encoding="utf-8")

            packages = check_licenses.scan_node_modules(node_modules)
            self.assertEqual([package.name for package in packages], ["@scope/child"])

    def test_node_packages_with_different_versions_are_kept(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_modules = Path(tmp) / "node_modules"
            first = node_modules / "package-a" / "package.json"
            second = node_modules / "parent" / "node_modules" / "package-a" / "package.json"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text('{"name":"package-a","version":"1.0.0","license":"MIT"}\n', encoding="utf-8")
            second.write_text('{"name":"package-a","version":"2.0.0","license":"MIT"}\n', encoding="utf-8")

            packages = check_licenses.scan_node_modules(node_modules)
            self.assertEqual(
                [(package.name, package.version) for package in packages],
                [("package-a", "1.0.0"), ("package-a", "2.0.0")],
            )

    def test_pnpm_virtual_store_packages_are_scanned_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_modules = Path(tmp) / "node_modules"
            virtual_store = node_modules / ".pnpm"

            left_pad = virtual_store / "left-pad@1.3.0" / "node_modules" / "left-pad" / "package.json"
            left_pad.parent.mkdir(parents=True)
            left_pad.write_text('{"name":"left-pad","version":"1.3.0","license":"WTFPL"}\n', encoding="utf-8")
            os.symlink(
                Path(".pnpm") / "left-pad@1.3.0" / "node_modules" / "left-pad",
                node_modules / "left-pad",
            )

            scoped = virtual_store / "@scope+pkg@2.0.0" / "node_modules" / "@scope" / "pkg" / "package.json"
            scoped.parent.mkdir(parents=True)
            scoped.write_text('{"name":"@scope/pkg","version":"2.0.0","license":"MIT"}\n', encoding="utf-8")
            scope = node_modules / "@scope"
            scope.mkdir()
            os.symlink(
                Path("..") / ".pnpm" / "@scope+pkg@2.0.0" / "node_modules" / "@scope" / "pkg",
                scope / "pkg",
            )

            parent = virtual_store / "parent@3.0.0" / "node_modules" / "parent"
            parent_package = parent / "package.json"
            parent_package.parent.mkdir(parents=True)
            parent_package.write_text('{"name":"parent","version":"3.0.0","license":"MIT"}\n', encoding="utf-8")
            child = parent / "node_modules" / "child" / "package.json"
            child.parent.mkdir(parents=True)
            child.write_text('{"name":"child","version":"1.0.0","license":"MIT"}\n', encoding="utf-8")

            child_v2 = virtual_store / "child@2.0.0" / "node_modules" / "child" / "package.json"
            child_v2.parent.mkdir(parents=True)
            child_v2.write_text('{"name":"child","version":"2.0.0","license":"MIT"}\n', encoding="utf-8")

            internal = parent / "dist" / "package.json"
            internal.parent.mkdir(parents=True)
            internal.write_text('{"name":"parent-internal","version":"3.0.0","license":"MIT"}\n', encoding="utf-8")

            packages = check_licenses.scan_node_modules(node_modules)
            self.assertEqual(
                sorted((package.name, package.version) for package in packages),
                [
                    ("@scope/pkg", "2.0.0"),
                    ("child", "1.0.0"),
                    ("child", "2.0.0"),
                    ("left-pad", "1.3.0"),
                    ("parent", "3.0.0"),
                ],
            )

    def test_collect_node_packages_uses_manager_specific_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "package.json").write_text('{"dependencies":{"example":"1.0.0"}}\n', encoding="utf-8")

            expected_commands = {
                "bun": [
                    "bun",
                    "install",
                    "--frozen-lockfile",
                    "--production",
                    "--ignore-scripts",
                ],
                "npm": [
                    "npm",
                    "ci",
                    "--omit=dev",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--cache",
                ],
                "pnpm": [
                    "pnpm",
                    "install",
                    "--frozen-lockfile",
                    "--prod",
                    "--ignore-scripts",
                ],
            }

            for manager, expected_prefix in expected_commands.items():
                with self.subTest(manager=manager), mock.patch.object(
                    check_licenses,
                    "run_command",
                    return_value=mock.Mock(returncode=0, stdout=""),
                ) as run_command:
                    check_licenses.collect_node_packages(target, manager)

                command = run_command.call_args.args[0]
                self.assertEqual(command[: len(expected_prefix)], expected_prefix)
                self.assertEqual(len(command), len(expected_prefix) + 1)
                if manager == "pnpm":
                    self.assertTrue(any(argument.startswith("--config.store-dir=") for argument in command))
                elif manager == "bun":
                    self.assertTrue(command[-1].startswith("--cache-dir="))
                else:
                    self.assertTrue(command[-1].endswith("/npm-cache"))


class PythonVersionSelectionTest(unittest.TestCase):
    def write_pyproject(self, target: Path, requires_python: str) -> None:
        target.mkdir(parents=True, exist_ok=True)
        (target / "pyproject.toml").write_text(
            f"[project]\nname='example'\nversion='0.1.0'\nrequires-python='{requires_python}'\n",
            encoding="utf-8",
        )

    def test_python_314_target_selects_314(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.write_pyproject(target, ">=3.14")
            self.assertEqual(check_licenses.select_python_version(target), "3.14")

    def test_python_312_target_defaults_to_313(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.write_pyproject(target, ">=3.12")
            self.assertEqual(check_licenses.select_python_version(target), "3.13")

    def test_python_version_file_takes_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.write_pyproject(target, ">=3.12")
            (target / ".python-version").write_text("3.12\n", encoding="utf-8")
            self.assertEqual(check_licenses.select_python_version(target), "3.12")

    def test_python_upper_bound_excluding_313_selects_312(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.write_pyproject(target, ">=3.12,<3.13")
            self.assertEqual(check_licenses.select_python_version(target), "3.12")


if __name__ == "__main__":
    unittest.main()
