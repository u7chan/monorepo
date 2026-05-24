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


if __name__ == "__main__":
    unittest.main()
