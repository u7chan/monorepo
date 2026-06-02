#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from email.parser import Parser
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "scripts" / "license-policy.json"

STATUS_PASS = "PASS"
STATUS_WARN = "WARN"
STATUS_FAIL = "FAIL"

REASON_ALLOWED = "LICENSE_ALLOWED"
REASON_DENIED = "LICENSE_DENIED"
REASON_REVIEW = "LICENSE_REVIEW_REQUIRED"
REASON_UNKNOWN = "LICENSE_UNKNOWN"
REASON_EXPRESSION_UNSUPPORTED = "EXPRESSION_UNSUPPORTED"
REASON_NOT_SUPPORTED = "NOT_SUPPORTED"
REASON_INSTALL_FAILED = "INSTALL_FAILED"
REASON_NO_DEPENDENCIES = "NO_DEPENDENCIES"

SUPPORTED_NODE_LOCKS = ("bun.lock", "bun.lockb", "package-lock.json")
UNSUPPORTED_NODE_LOCKS = ("yarn.lock", "pnpm-lock.yaml")
NODE_DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
SUPPORTED_PYTHON_LOCKS = ("uv.lock",)
UNSUPPORTED_PYTHON_LOCKS = ("requirements.txt", "poetry.lock", "Pipfile.lock")


@dataclass(frozen=True)
class PackageInfo:
    ecosystem: str
    name: str
    version: str
    license: str | None


@dataclass(frozen=True)
class CheckItem:
    status: str
    reason_code: str
    package: PackageInfo | None
    message: str


@dataclass(frozen=True)
class TargetSummary:
    target: Path
    packages_checked: int
    pass_count: int
    warn_count: int
    fail_count: int
    items: list[CheckItem]


def load_policy(path: Path = POLICY_PATH) -> dict:
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def validate_policy(policy: dict) -> list[str]:
    errors: list[str] = []
    for key in ("allowed", "review", "denied", "overrides"):
        if key not in policy:
            errors.append(f"missing required key: {key}")

    for key in ("allowed", "review", "denied"):
        value = policy.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            errors.append(f"{key} must be a list of strings")

    overrides = policy.get("overrides")
    if not isinstance(overrides, list):
        errors.append("overrides must be a list")
    else:
        for index, override in enumerate(overrides):
            prefix = f"overrides[{index}]"
            if not isinstance(override, dict):
                errors.append(f"{prefix} must be an object")
                continue
            for key in ("ecosystem", "name", "status", "reason", "reviewed_at"):
                if not override.get(key):
                    errors.append(f"{prefix}.{key} is required")
            if override.get("status") not in ("allowed", "review", "denied"):
                errors.append(f"{prefix}.status must be one of allowed, review, denied")
            if "version" in override and not isinstance(override["version"], str):
                errors.append(f"{prefix}.version must be a string")

    return errors


def normalize_license(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, dict):
        value_type = value.get("type")
        if isinstance(value_type, str) and value_type.strip():
            return value_type.strip()
    if isinstance(value, list):
        parts = [normalize_license(item) for item in value]
        parts = [part for part in parts if part]
        if parts:
            return " OR ".join(parts)
    return None


def pattern_match(patterns: Iterable[str], license_id: str) -> bool:
    license_lower = license_id.lower()
    for pattern in patterns:
        if fnmatch.fnmatchcase(license_lower, pattern.lower()):
            return True
    return False


def find_override(policy: dict, package: PackageInfo) -> dict | None:
    for override in policy.get("overrides", []):
        if override.get("ecosystem") != package.ecosystem:
            continue
        if override.get("name") != package.name:
            continue
        version = override.get("version")
        if version and version != package.version:
            continue
        return override
    return None


def classify_identifier(policy: dict, license_id: str) -> tuple[str, str]:
    if pattern_match(policy.get("denied", []), license_id):
        return STATUS_FAIL, REASON_DENIED
    if pattern_match(policy.get("review", []), license_id):
        return STATUS_WARN, REASON_REVIEW
    if pattern_match(policy.get("allowed", []), license_id):
        return STATUS_PASS, REASON_ALLOWED
    return STATUS_WARN, REASON_UNKNOWN


def tokenize_expression(expression: str) -> list[str] | None:
    cleaned = expression.strip()
    if not cleaned:
        return None
    if any(mark in cleaned for mark in (",", ";", "/", "\\")):
        return None
    tokens = re.findall(r"\(|\)|\bAND\b|\bOR\b|[A-Za-z0-9.+:*-]+", cleaned, flags=re.IGNORECASE)
    if not tokens or "".join(tokens).lower() == cleaned.replace(" ", "").lower():
        return tokens
    return None


def split_top_level(tokens: list[str], operator: str) -> list[list[str]]:
    depth = 0
    parts: list[list[str]] = [[]]
    for token in tokens:
        upper = token.upper()
        if token == "(":
            depth += 1
            parts[-1].append(token)
        elif token == ")":
            depth -= 1
            parts[-1].append(token)
        elif depth == 0 and upper == operator:
            parts.append([])
        else:
            parts[-1].append(token)
    return parts


def trim_parens(tokens: list[str]) -> list[str]:
    while len(tokens) >= 2 and tokens[0] == "(" and tokens[-1] == ")":
        depth = 0
        balanced = True
        for index, token in enumerate(tokens):
            if token == "(":
                depth += 1
            elif token == ")":
                depth -= 1
                if depth == 0 and index != len(tokens) - 1:
                    balanced = False
                    break
            if depth < 0:
                balanced = False
                break
        if balanced and depth == 0:
            tokens = tokens[1:-1]
        else:
            break
    return tokens


def combine_or(results: list[tuple[str, str]]) -> tuple[str, str]:
    if any(status == STATUS_PASS for status, _ in results):
        return STATUS_PASS, REASON_ALLOWED
    if any(status == STATUS_WARN for status, _ in results):
        reason = next(reason for status, reason in results if status == STATUS_WARN)
        return STATUS_WARN, reason
    return STATUS_FAIL, REASON_DENIED


def combine_and(results: list[tuple[str, str]]) -> tuple[str, str]:
    if any(status == STATUS_FAIL for status, _ in results):
        return STATUS_FAIL, REASON_DENIED
    if any(status == STATUS_WARN for status, _ in results):
        reason = next(reason for status, reason in results if status == STATUS_WARN)
        return STATUS_WARN, reason
    return STATUS_PASS, REASON_ALLOWED


def classify_tokens(policy: dict, tokens: list[str]) -> tuple[str, str]:
    tokens = trim_parens(tokens)
    if not tokens:
        return STATUS_WARN, REASON_EXPRESSION_UNSUPPORTED

    if "WITH" in [token.upper() for token in tokens]:
        return STATUS_WARN, REASON_EXPRESSION_UNSUPPORTED

    or_parts = split_top_level(tokens, "OR")
    if len(or_parts) > 1:
        return combine_or([classify_tokens(policy, part) for part in or_parts])

    and_parts = split_top_level(tokens, "AND")
    if len(and_parts) > 1:
        return combine_and([classify_tokens(policy, part) for part in and_parts])

    if len(tokens) == 1 and tokens[0] not in ("(", ")"):
        return classify_identifier(policy, tokens[0])

    return STATUS_WARN, REASON_EXPRESSION_UNSUPPORTED


def classify_license(policy: dict, package: PackageInfo) -> tuple[str, str]:
    override = find_override(policy, package)
    if override:
        status = override["status"]
        if status == "allowed":
            return STATUS_PASS, REASON_ALLOWED
        if status == "review":
            return STATUS_WARN, REASON_REVIEW
        return STATUS_FAIL, REASON_DENIED

    if not package.license:
        return STATUS_WARN, REASON_UNKNOWN

    tokens = tokenize_expression(package.license)
    if tokens is None:
        return STATUS_WARN, REASON_EXPRESSION_UNSUPPORTED
    return classify_tokens(policy, tokens)


def run_command(
    command: list[str],
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command_env = os.environ.copy()
    if env:
        command_env.update(env)
    return subprocess.run(
        command,
        cwd=cwd,
        env=command_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def copy_target(target: Path, destination: Path) -> None:
    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"}
        return ignored.intersection(names)

    shutil.copytree(target, destination, ignore=ignore)


def detect_target_managers(target: Path) -> list[tuple[str, str | None]]:
    managers: list[tuple[str, str | None]] = []

    if (target / "package.json").exists():
        unsupported = [name for name in UNSUPPORTED_NODE_LOCKS if (target / name).exists()]
        if unsupported:
            managers.append(("node", f"unsupported lockfile: {', '.join(unsupported)}"))
        elif (target / "bun.lock").exists() or (target / "bun.lockb").exists():
            managers.append(("bun", None))
        elif (target / "package-lock.json").exists():
            managers.append(("npm", None))
        elif not has_node_dependencies(target / "package.json"):
            managers.append(("node-empty", None))
        else:
            managers.append(("node", "missing supported lockfile"))

    if (target / "pyproject.toml").exists():
        unsupported = [name for name in UNSUPPORTED_PYTHON_LOCKS if (target / name).exists()]
        if (target / "uv.lock").exists():
            managers.append(("uv", None))
        elif unsupported:
            managers.append(("python", f"unsupported dependency file: {', '.join(unsupported)}"))
        else:
            managers.append(("python", "missing uv.lock"))

    if not managers:
        managers.append(("unknown", "package.json or pyproject.toml not found"))

    return managers


def has_node_dependencies(package_json: Path) -> bool:
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True

    if not isinstance(data, dict):
        return True

    for field in NODE_DEPENDENCY_FIELDS:
        value = data.get(field)
        if isinstance(value, dict):
            if value:
                return True
        elif value:
            return True
    return False


def collect_node_packages(target: Path, manager: str) -> tuple[list[PackageInfo], CheckItem | None]:
    with tempfile.TemporaryDirectory(prefix="license-check-node-") as tmp:
        workdir = Path(tmp) / "target"
        copy_target(target, workdir)
        if manager == "bun":
            command = [
                "bun",
                "install",
                "--frozen-lockfile",
                "--production",
                "--ignore-scripts",
                f"--cache-dir={Path(tmp) / 'bun-cache'}",
            ]
        else:
            command = [
                "npm",
                "ci",
                "--omit=dev",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--cache",
                str(Path(tmp) / "npm-cache"),
            ]
        result = run_command(
            command,
            workdir,
            {
                "BUN_INSTALL_CACHE_DIR": str(Path(tmp) / "bun-cache"),
                "npm_config_cache": str(Path(tmp) / "npm-cache"),
            },
        )
        if result.returncode != 0:
            return [], CheckItem(
                STATUS_FAIL,
                REASON_INSTALL_FAILED,
                None,
                f"{manager} install failed for {target}: {compact_output(result.stdout)}",
            )
        return scan_node_modules(workdir / "node_modules"), None


def scan_node_modules(node_modules: Path) -> list[PackageInfo]:
    packages: list[PackageInfo] = []
    seen: set[tuple[str, str]] = set()
    if not node_modules.exists():
        return packages

    for package_json in sorted(node_modules.rglob("package.json")):
        if not is_node_package_root(node_modules, package_json):
            continue
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        name = str(data.get("name") or package_json.parent.name)
        version = str(data.get("version") or "")
        key = (name, version)
        if key in seen:
            continue
        seen.add(key)
        packages.append(PackageInfo("npm", name, version, normalize_license(data.get("license"))))
    return packages


def is_node_package_root(node_modules: Path, package_json: Path) -> bool:
    try:
        relative_parts = package_json.relative_to(node_modules).parts
    except ValueError:
        return False
    if len(relative_parts) < 2 or relative_parts[-1] != "package.json":
        return False
    parent_parts = relative_parts[:-1]
    if parent_parts[-1] == "node_modules":
        return False
    if len(parent_parts) >= 2 and parent_parts[-2].startswith("@"):
        return True
    if len(parent_parts) >= 1 and parent_parts[-1].startswith("@"):
        return False
    return len(parent_parts) == 1 or parent_parts[-2] == "node_modules"


def collect_python_packages(target: Path) -> tuple[list[PackageInfo], CheckItem | None]:
    with tempfile.TemporaryDirectory(prefix="license-check-python-") as tmp:
        workdir = Path(tmp) / "target"
        copy_target(target, workdir)
        python_version = select_python_version(target)
        command = [
            "uv",
            "sync",
            "--frozen",
            "--no-dev",
            "--no-install-project",
            "--no-install-workspace",
            "--python",
            python_version,
            "--no-progress",
            "--color",
            "never",
            "--link-mode",
            "copy",
            "--cache-dir",
            str(Path(tmp) / "uv-cache"),
        ]
        result = run_command(
            command,
            workdir,
            {
                "UV_CACHE_DIR": str(Path(tmp) / "uv-cache"),
                "UV_PYTHON_INSTALL_DIR": str(Path(tmp) / "uv-python"),
            },
        )
        if result.returncode != 0:
            return [], CheckItem(
                STATUS_FAIL,
                REASON_INSTALL_FAILED,
                None,
                f"uv sync failed for {target}: {compact_output(result.stdout)}",
            )
        return scan_python_metadata(workdir / ".venv"), None


def select_python_version(target: Path) -> str:
    version_file = target / ".python-version"
    try:
        pinned_version = version_file.read_text(encoding="utf-8").strip()
    except OSError:
        pinned_version = ""
    if re.fullmatch(r"\d+\.\d+(?:\.\d+)?", pinned_version):
        return pinned_version

    requires_python = read_requires_python(target / "pyproject.toml")
    if requires_python and requires_python_requires_at_least(requires_python, 3, 14):
        return "3.14"
    if requires_python and requires_python_excludes(requires_python, 3, 13):
        return "3.12"
    return "3.13"


def read_requires_python(pyproject_path: Path) -> str | None:
    try:
        with pyproject_path.open("rb") as file:
            data = tomllib.load(file)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    value = data.get("project", {}).get("requires-python")
    return value if isinstance(value, str) else None


def requires_python_requires_at_least(requires_python: str, major: int, minor: int) -> bool:
    target = (major, minor)
    for operator, version in parse_python_specifiers(requires_python):
        if operator in (">=", ">", "==", "~=") and version >= target:
            return True
    return False


def requires_python_excludes(requires_python: str, major: int, minor: int) -> bool:
    target = (major, minor)
    for operator, version in parse_python_specifiers(requires_python):
        if operator == "<" and target >= version:
            return True
        if operator == "<=" and target > version:
            return True
        if operator == "==" and target != version:
            return True
    return False


def parse_python_specifiers(requires_python: str) -> list[tuple[str, tuple[int, int]]]:
    specifiers: list[tuple[str, tuple[int, int]]] = []
    for operator, major, minor in re.findall(r"(<=|>=|==|~=|<|>)\s*(\d+)\.(\d+)", requires_python):
        specifiers.append((operator, (int(major), int(minor))))
    return specifiers


def scan_python_metadata(venv: Path) -> list[PackageInfo]:
    packages: list[PackageInfo] = []
    metadata_files = sorted(venv.glob("lib/python*/site-packages/*.dist-info/METADATA"))
    metadata_files.extend(sorted(venv.glob("Lib/site-packages/*.dist-info/METADATA")))

    for metadata_file in metadata_files:
        try:
            message = Parser().parsestr(metadata_file.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        name = message.get("Name") or metadata_file.parent.name.rsplit("-", 1)[0]
        version = message.get("Version") or ""
        license_value = message.get("License-Expression") or license_from_classifiers(message.get_all("Classifier", []))
        if not license_value:
            license_value = message.get("License")
        packages.append(PackageInfo("pypi", name, version, normalize_license(license_value)))
    return packages


def license_from_classifiers(classifiers: Iterable[str]) -> str | None:
    mapping = {
        "MIT License": "MIT",
        "Apache Software License": "Apache-2.0",
        "BSD License": "BSD-*",
        "ISC License": "ISC",
        "Mozilla Public License": "MPL-*",
        "GNU Lesser General Public License": "LGPL-*",
        "GNU General Public License": "GPL-*",
        "GNU Affero General Public License": "AGPL-*",
        "Eclipse Public License": "EPL-*",
    }
    for classifier in classifiers:
        for marker, spdx in mapping.items():
            if marker in classifier:
                return spdx
    return None


def compact_output(output: str, limit: int = 1200) -> str:
    compact = " ".join(output.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def check_target(target: Path, policy: dict) -> TargetSummary:
    target = target.resolve()
    items: list[CheckItem] = []
    packages: list[PackageInfo] = []

    for manager, unsupported_reason in detect_target_managers(target):
        if unsupported_reason:
            items.append(CheckItem(STATUS_FAIL, REASON_NOT_SUPPORTED, None, f"{target}: {unsupported_reason}"))
            continue
        if manager in ("bun", "npm"):
            collected, install_error = collect_node_packages(target, manager)
        elif manager == "node-empty":
            items.append(
                CheckItem(
                    STATUS_PASS,
                    REASON_NO_DEPENDENCIES,
                    None,
                    f"{target}: no Node dependencies declared; supported lockfile is not required",
                )
            )
            continue
        elif manager == "uv":
            collected, install_error = collect_python_packages(target)
        else:
            collected, install_error = [], CheckItem(STATUS_FAIL, REASON_NOT_SUPPORTED, None, f"{target}: unsupported target")
        if install_error:
            items.append(install_error)
        packages.extend(collected)

    pass_count = 0
    warn_count = 0
    fail_count = 0
    for package in packages:
        status, reason = classify_license(policy, package)
        if status == STATUS_PASS:
            pass_count += 1
        elif status == STATUS_WARN:
            warn_count += 1
            items.append(CheckItem(status, reason, package, "license requires attention"))
        else:
            fail_count += 1
            items.append(CheckItem(status, reason, package, "license is denied"))

    fail_count += sum(1 for item in items if item.status == STATUS_FAIL and item.package is None)
    warn_count += sum(1 for item in items if item.status == STATUS_WARN and item.package is None)

    return TargetSummary(target, len(packages), pass_count, warn_count, fail_count, items)


def parse_targets(args: argparse.Namespace) -> list[Path]:
    targets: list[str] = []
    if args.target:
        targets.append(args.target)
    if args.targets:
        targets.extend(split_values(args.targets))
    if args.changed_targets_file:
        targets.extend(read_targets_file(Path(args.changed_targets_file)))
    if args.all_targets:
        targets.extend(str(path.relative_to(ROOT)) for path in discover_all_targets())
    unique: list[Path] = []
    seen: set[Path] = set()
    for target in targets:
        path = (ROOT / target).resolve() if not Path(target).is_absolute() else Path(target).resolve()
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def split_values(value: str) -> list[str]:
    parsed: list[str] = []
    for row in csv.reader([value]):
        parsed.extend(item.strip() for item in row if item.strip())
    return parsed


def read_targets_file(path: Path) -> list[str]:
    values: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        values.extend(split_values(stripped))
    return values


def discover_all_targets() -> list[Path]:
    targets: set[Path] = set()
    projects = ROOT / "projects"
    for manifest in projects.rglob("package.json"):
        if "node_modules" not in manifest.parts:
            targets.add(manifest.parent)
    for manifest in projects.rglob("pyproject.toml"):
        if ".venv" not in manifest.parts:
            targets.add(manifest.parent)
    return sorted(targets)


def print_target_summary(summary: TargetSummary) -> None:
    relative = summary.target.relative_to(ROOT) if summary.target.is_relative_to(ROOT) else summary.target
    print("==============================")
    print(f"License check: {relative}")
    print("==============================")
    print(f"status: {summary_status(summary.warn_count, summary.fail_count)}")
    print(f"packages checked: {summary.packages_checked}")
    print(f"pass: {summary.pass_count}")
    print(f"warn: {summary.warn_count}")
    print(f"fail: {summary.fail_count}")
    print("")
    for item in summary.items:
        print(format_item(item))
    if summary.items:
        print("")


def format_item(item: CheckItem) -> str:
    if item.package:
        package = item.package
        license_text = format_license_for_log(package.license)
        return (
            f"{item.status} {item.reason_code} "
            f"ecosystem={package.ecosystem} package={package.name} "
            f"version={package.version} license={license_text} reason={item.message}"
        )
    return f"{item.status} {item.reason_code} reason={item.message}"


def format_license_for_log(license_text: str | None, limit: int = 160) -> str:
    if not license_text:
        return "UNKNOWN"
    compact = " ".join(license_text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def summary_status(warn_count: int, fail_count: int) -> str:
    if fail_count:
        return "FAIL"
    if warn_count:
        return "PASS_WITH_WARNINGS"
    return "PASS"


def print_overall_summary(summaries: list[TargetSummary]) -> None:
    packages = sum(summary.packages_checked for summary in summaries)
    passes = sum(summary.pass_count for summary in summaries)
    warns = sum(summary.warn_count for summary in summaries)
    fails = sum(summary.fail_count for summary in summaries)
    print("==============================")
    print("License check summary")
    print("==============================")
    print(f"targets checked: {len(summaries)}")
    print(f"packages checked: {packages}")
    print(f"pass: {passes}")
    print(f"warn: {warns}")
    print(f"fail: {fails}")
    print(f"result: {summary_status(warns, fails)}")


def write_json_report(path: Path, summaries: list[TargetSummary]) -> None:
    data = {
        "targets": [
            {
                "target": str(summary.target.relative_to(ROOT) if summary.target.is_relative_to(ROOT) else summary.target),
                "packages_checked": summary.packages_checked,
                "pass": summary.pass_count,
                "warn": summary.warn_count,
                "fail": summary.fail_count,
                "items": [
                    {
                        "status": item.status,
                        "reason_code": item.reason_code,
                        "message": item.message,
                        "package": None
                        if item.package is None
                        else {
                            "ecosystem": item.package.ecosystem,
                            "name": item.package.name,
                            "version": item.package.version,
                            "license": item.package.license,
                        },
                    }
                    for item in summary.items
                ],
            }
            for summary in summaries
        ]
    }
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Check OSS licenses for Node and Python production dependencies.")
    parser.add_argument("--target", help="Target directory to check.")
    parser.add_argument("--targets", help="Comma-separated target directories to check.")
    parser.add_argument("--changed-targets-file", help="File containing target directories.")
    parser.add_argument("--all-targets", action="store_true", help="Check all package.json and pyproject.toml targets.")
    parser.add_argument("--validate-policy", action="store_true", help="Validate scripts/license-policy.json.")
    parser.add_argument("--json-output", help="Write a JSON report to this path.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    policy = load_policy()
    errors = validate_policy(policy)
    if errors:
        for error in errors:
            print(f"FAIL POLICY_INVALID reason={error}")
        return 1
    if args.validate_policy:
        print("Policy validation: PASS")

    targets = parse_targets(args)
    if not targets:
        if args.validate_policy:
            return 0
        parser.error("no targets specified")

    summaries = [check_target(target, policy) for target in targets]
    for summary in summaries:
        print_target_summary(summary)
    print_overall_summary(summaries)

    if args.json_output:
        write_json_report(Path(args.json_output), summaries)

    return 1 if any(summary.fail_count for summary in summaries) else 0


if __name__ == "__main__":
    raise SystemExit(main())
