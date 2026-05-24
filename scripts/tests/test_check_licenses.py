from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "check_licenses.py"
SPEC = importlib.util.spec_from_file_location("check_licenses", MODULE_PATH)
check_licenses = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["check_licenses"] = check_licenses
SPEC.loader.exec_module(check_licenses)


POLICY = {
    "allowed": ["MIT", "Apache-2.0", "BSD-*", "ISC", "0BSD", "Unlicense", "Python-2.0", "BlueOak-*"],
    "review": ["LGPL-*", "MPL-*", "EPL-*", "CDDL-*"],
    "denied": ["AGPL-*", "GPL-*", "SSPL-*", "Commons Clause"],
    "overrides": [],
}


class PolicyValidationTest(unittest.TestCase):
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

    def test_allowed_and_review_warns(self) -> None:
        self.assertEqual(self.classify("MIT AND MPL-2.0"), ("WARN", "LICENSE_REVIEW_REQUIRED"))

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


class TargetDetectionTest(unittest.TestCase):
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

    def test_python_upper_bound_excluding_313_selects_312(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            self.write_pyproject(target, ">=3.12,<3.13")
            self.assertEqual(check_licenses.select_python_version(target), "3.12")


if __name__ == "__main__":
    unittest.main()
