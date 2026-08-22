#!/usr/bin/env python3
"""Maintain .github/dependabot.yml based on projects/* lockfiles."""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

CONFIG = Path(".github/dependabot.yml")
PROJECTS = Path("projects")
REQUIRED_LABEL = "dependabot-auto-process"


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
    """Update an existing block while adding the required processing label."""
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

    return ensure_required_label(new_block)


def _entry_from_block(block: list[str]) -> dict[str, Any]:
    """Parse one text entry using the same YAML rules as the final config."""
    parsed = yaml.safe_load("updates:\n" + "\n".join(block))
    if not isinstance(parsed, dict) or not isinstance(parsed.get("updates"), list):
        raise ValueError("entry block is not a YAML updates entry")
    if len(parsed["updates"]) != 1 or not isinstance(parsed["updates"][0], dict):
        raise ValueError("entry block does not contain exactly one mapping")
    return parsed["updates"][0]


def _format_label(label: Any) -> str:
    """Render a label as a YAML scalar suitable for a list item."""
    if isinstance(label, str):
        return json.dumps(label, ensure_ascii=False)
    return yaml.safe_dump(label, default_flow_style=True).strip().removesuffix(
        "\n..."
    )


def ensure_required_label(block: list[str]) -> list[str]:
    """Add ``REQUIRED_LABEL`` to a block without dropping existing labels."""
    entry = _entry_from_block(block)
    labels = entry.get("labels")
    if isinstance(labels, list) and REQUIRED_LABEL in labels:
        return block

    labels_match: int | None = None
    for index, line in enumerate(block):
        if re.match(r"^    labels:\s*", line):
            labels_match = index
            break

    if labels_match is None:
        insert_at = next(
            (
                index
                for index, line in enumerate(block)
                if line.startswith("    groups:")
            ),
            len(block),
        )
        while insert_at > 0 and block[insert_at - 1] == "":
            insert_at -= 1
        return (
            block[:insert_at]
            + ["    labels:", f'      - "{REQUIRED_LABEL}"']
            + block[insert_at:]
        )

    labels_line = block[labels_match]
    labels_value = labels_line.split(":", 1)[1].strip()
    if labels_value:
        # Inline labels cannot accept another indented list item. Expand the
        # existing values while keeping their order, then append the required
        # selector label.
        existing_labels = labels if isinstance(labels, list) else [labels]
        expanded = ["    labels:"] + [
            f"      - {_format_label(label)}" for label in existing_labels
        ]
        expanded.append(f'      - "{REQUIRED_LABEL}"')
        return block[:labels_match] + expanded + block[labels_match + 1 :]

    # Block-style labels: insert after their nested values and before the next
    # top-level entry field. Blank lines are kept with the following field.
    insert_at = labels_match + 1
    while insert_at < len(block):
        line = block[insert_at]
        if line == "" or line.startswith("      ") or line.startswith("\t"):
            insert_at += 1
            continue
        if re.match(r"^    \S", line):
            break
        insert_at += 1
    while insert_at > labels_match + 1 and block[insert_at - 1] == "":
        insert_at -= 1
    return (
        block[:insert_at]
        + [f'      - "{REQUIRED_LABEL}"']
        + block[insert_at:]
    )


def build_new_block(ecosystem: str, directory: str) -> list[str]:
    name = directory.split("/")[-1]
    return [
        f'  - package-ecosystem: "{ecosystem}"',
        f'    directory: "{directory}"',
        '    schedule:',
        '      interval: "weekly"',
        '    open-pull-requests-limit: 1',
        '    rebase-strategy: "disabled"',
        '    labels:',
        f'      - "{REQUIRED_LABEL}"',
        '    groups:',
        f'      {name}-minor-and-patch:',
        '        applies-to: version-updates',
        '        patterns:',
        '          - "*"',
        '        update-types:',
        '          - "minor"',
        '          - "patch"',
    ]


def coverage_errors(config: Any, detected: dict[str, str]) -> list[str]:
    """Return coverage and required-label errors for a parsed config."""
    errors: list[str] = []
    if not isinstance(config, dict):
        return ["configuration root must be a mapping"]

    updates = config.get("updates")
    if not isinstance(updates, list):
        return ["configuration must contain an updates list"]

    directory_counts: Counter[str] = Counter()
    for index, entry in enumerate(updates, start=1):
        if not isinstance(entry, dict):
            errors.append(f"updates entry {index} must be a mapping")
            continue

        directory = entry.get("directory")
        if isinstance(directory, str):
            directory_counts[directory] += 1
            entry_name = directory
        else:
            entry_name = f"entry {index}"

        labels = entry.get("labels")
        if not isinstance(labels, list) or REQUIRED_LABEL not in labels:
            errors.append(
                f"{entry_name} is missing required label {REQUIRED_LABEL!r}"
            )

    for directory in sorted(detected):
        count = directory_counts[directory]
        if count == 0:
            errors.append(f"missing updates entry for {directory}")
        elif count != 1:
            errors.append(
                f"{directory} must have exactly one updates entry (found {count})"
            )

    for directory in sorted(set(directory_counts) - set(detected)):
        errors.append(f"stale updates entry for {directory}")

    return errors


def validate_coverage(config: Any, detected: dict[str, str]) -> None:
    """Raise ``ValueError`` when entries or required labels are incomplete."""
    errors = coverage_errors(config, detected)
    if errors:
        details = "\n".join(f"- {error}" for error in errors)
        raise ValueError(f"coverage validation failed:\n{details}")


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

    # Validate the preview before writing it. This keeps a template or future
    # edit from silently producing an entry without the selector label.
    try:
        validate_coverage(yaml.safe_load(desired_text), detected)
    except (ValueError, yaml.YAMLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    # 9. Apply and validate
    CONFIG.write_text(desired_text, encoding="utf-8")
    preview_path.unlink()
    final = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    try:
        validate_coverage(final, detected)
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Updated and validated:", CONFIG)

    return 0


if __name__ == "__main__":
    sys.exit(main())
