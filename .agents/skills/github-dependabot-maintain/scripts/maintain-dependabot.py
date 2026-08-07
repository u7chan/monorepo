#!/usr/bin/env python3
"""Maintain .github/dependabot.yml based on projects/* lockfiles."""

import re
import subprocess
import sys
from pathlib import Path

import yaml

CONFIG = Path(".github/dependabot.yml")
PROJECTS = Path("projects")


def detect_ecosystem(project_dir: Path) -> str | None:
    if (project_dir / "bun.lock").exists() or (project_dir / "bun.lockb").exists():
        return "bun"
    if (project_dir / "uv.lock").exists():
        return "uv"
    return None


def parse_entries(text: str) -> tuple[str, dict[str, list[str]]]:
    """Split dependabot.yml into header and directory-indexed entry blocks.

    The file is expected to follow the simple two-space indentation structure
    produced by this repository. Each entry starts with ``  - package-ecosystem``
    and contains a ``    directory: ...`` line.
    """
    lines = text.splitlines()
    header_lines: list[str] = []
    entries: dict[str, list[str]] = {}
    current_dir: str | None = None
    current_block: list[str] = []
    state = "header"
    dir_re = re.compile(r'^    directory:\s*"?([^"]+)"?\s*$')

    for line in lines:
        if state == "header":
            header_lines.append(line)
            if line.strip() == "updates:":
                state = "entries"
            continue

        if line.startswith("  - package-ecosystem:"):
            if current_dir is not None:
                entries[current_dir] = current_block
            current_dir = None
            current_block = [line]
            continue

        if current_dir is None and current_block:
            m = dir_re.match(line)
            if m:
                current_dir = m.group(1)

        current_block.append(line)

    if current_dir is not None:
        entries[current_dir] = current_block

    return "\n".join(header_lines), entries


def normalize_block(block: list[str], ecosystem: str, directory: str) -> list[str]:
    """Update package-ecosystem, directory, and groups in an existing block."""
    name = directory.split("/")[-1]
    new_block: list[str] = []
    in_groups = False

    for line in block:
        if line.startswith("  - package-ecosystem:"):
            new_block.append(f'  - package-ecosystem: "{ecosystem}"')
            continue

        if line.startswith("    directory:"):
            new_block.append(f'    directory: "{directory}"')
            continue

        if line.startswith("    groups:"):
            in_groups = True
            new_block.append("    groups:")
            new_block.append(f"      {name}-minor-and-patch:")
            new_block.append("        applies-to: version-updates")
            new_block.append("        patterns:")
            new_block.append('          - "*"')
            new_block.append("        update-types:")
            new_block.append('          - "minor"')
            new_block.append('          - "patch"')
            continue

        if in_groups:
            # The next field at the entry's top level is indented 4 spaces.
            # Blank lines and deeper indentation belong to the groups section.
            if line == "":
                continue
            if re.match(r"^    \w", line) and not re.match(r"^      ", line):
                in_groups = False
            else:
                continue

        new_block.append(line)

    return new_block


def build_new_block(ecosystem: str, directory: str) -> list[str]:
    name = directory.split("/")[-1]
    return [
        f'  - package-ecosystem: "{ecosystem}"',
        f'    directory: "{directory}"',
        '    schedule:',
        '      interval: "weekly"',
        '    open-pull-requests-limit: 1',
        '    rebase-strategy: "disabled"',
        '    groups:',
        f'      {name}-minor-and-patch:',
        '        applies-to: version-updates',
        '        patterns:',
        '          - "*"',
        '        update-types:',
        '          - "minor"',
        '          - "patch"',
    ]


def main() -> int:
    # 1. Safety check for staged and unstaged changes
    result = subprocess.run(
        ["git", "status", "--porcelain", "--", str(CONFIG)],
        capture_output=True,
        text=True,
        check=True,
    )
    if result.stdout.strip():
        print(
            f"ERROR: {CONFIG} has uncommitted changes. Commit or revert them first.",
            file=sys.stderr,
        )
        return 1

    # 2. Load existing config text and split into blocks
    text = (
        CONFIG.read_text(encoding="utf-8")
        if CONFIG.exists()
        else "version: 2\nupdates:\n"
    )
    header, existing_entries = parse_entries(text)

    # 3. Scan projects
    detected: dict[str, str] = {}
    for project_dir in sorted(PROJECTS.iterdir()):
        if not project_dir.is_dir():
            continue
        name = project_dir.name
        if name in ("_labs", "_samples"):
            continue
        ecosystem = detect_ecosystem(project_dir)
        if ecosystem is not None:
            detected[f"/projects/{name}"] = ecosystem

    # 4. Build desired blocks, preserving existing settings
    desired_blocks: list[list[str]] = []
    for directory in sorted(detected.keys()):
        ecosystem = detected[directory]
        if directory in existing_entries:
            block = normalize_block(existing_entries[directory], ecosystem, directory)
        else:
            block = build_new_block(ecosystem, directory)
        desired_blocks.append(block)

    # 5. Compose desired text with blank lines between entries
    desired_lines = header.splitlines()
    for i, block in enumerate(desired_blocks):
        if i > 0:
            desired_lines.append("")
        desired_lines.extend(block)

    desired_text = "\n".join(desired_lines)
    if not desired_text.endswith("\n"):
        desired_text += "\n"

    # 6. Write preview
    preview_path = CONFIG.with_suffix(".yml.preview")
    preview_path.write_text(desired_text, encoding="utf-8")

    # 7. Show diff
    subprocess.run(["diff", "-u", str(CONFIG), str(preview_path)])

    # 8. Wait for explicit approval
    answer = input("Apply changes? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        print("Aborted. Preview kept at:", preview_path)
        return 0

    # 9. Apply and validate
    CONFIG.write_text(desired_text, encoding="utf-8")
    preview_path.unlink()
    yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    print("Updated and validated:", CONFIG)

    # 10. Recheck coverage
    final = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    final_dirs = {entry["directory"] for entry in final.get("updates", [])}
    missing = set(detected.keys()) - final_dirs
    extra = final_dirs - set(detected.keys())
    if missing or extra:
        print(
            f"ERROR: coverage mismatch. missing={missing}, extra={extra}",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
