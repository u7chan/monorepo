---
name: file-server-design
description: >
  Use this when working on UI or UX changes in the file-server project, especially for
  buttons, colors, dialogs, empty states, and visual consistency across Hono JSX + HTMX screens.
  It captures the project's design direction so future design edits stay aligned.
---

# File Server Design

## Overview

Use this skill for UI-facing changes in `projects/file-server`.
It keeps visual changes aligned with the current product direction instead of making one-off styling decisions.

## When to Use This Skill

- When changing button styles, accent colors, gradients, or action hierarchy
- When editing dialogs, file viewer UI, list actions, or inline forms
- When adding or revising empty states, placeholders, helper text, or feedback copy
- When reviewing whether a UI change matches the existing visual language

## What the Agent Does

1. Inspect the affected UI and identify the action roles involved.
2. Read `references/design-guidelines.md` before proposing or implementing visual changes.
3. Reuse the existing visual language unless there is an explicit request to change it.
4. Keep color semantics consistent across list views, dialogs, and editor states.
5. Preserve HTMX behavior, auth behavior, and path-safety constraints while changing presentation.
6. Add or update tests when UI output changes in a way the current test suite asserts.

## Input and Output

**Input:**
- A UI or UX change request in `projects/file-server`
- Existing Hono JSX components and HTML-based tests

**Output:**
- Consistent design decisions for the changed UI
- Updated components and tests that reflect the project design rules

## Step Details

### Step 1: Read the Design Reference

Open `references/design-guidelines.md`.
Use it as the source of truth for button roles, color semantics, empty states, and scope boundaries.

### Step 2: Map Actions to Roles

For each changed control, decide whether it is:
- `primary`
- `secondary`
- `danger`
- `dismiss`

Do not assign styles by feature name alone.
Assign them by user intent and risk level.

### Step 3: Preserve the Product Shape

Keep the current visual language:
- soft indigo/purple/pink page palette
- rounded containers and controls
- gradients used selectively, not everywhere
- strong distinction between destructive and non-destructive actions

Avoid introducing a new palette or a competing button system unless the user explicitly asks for a redesign.

### Step 4: Handle Empty States Explicitly

When content can be empty, show that emptiness intentionally.
Do not leave bordered panels, editors, or dialogs looking broken or unfinished.

### Step 5: Protect Non-Visual Behavior

Do not break:
- HTMX targets, swaps, and push-url behavior
- file/path validation rules
- auth scope behavior
- current routes and API contracts

### Step 6: Update Tests

If HTML output or copy changes, update or add tests in `tests/` so the intended UX is locked in.

## Quality Check

- [ ] The changed UI follows the role-based button rules in the reference
- [ ] Destructive actions are not visually confused with close/cancel actions
- [ ] Empty content states are explicit, not silent blanks
- [ ] Existing HTMX and file-server behavior is preserved
- [ ] Tests cover new visible behavior when relevant

## References

- `references/design-guidelines.md`
- `src/components/FileList.tsx`
- `src/components/file-viewer/`
