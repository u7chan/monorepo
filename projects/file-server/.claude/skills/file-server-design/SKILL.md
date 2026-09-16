---
name: file-server-design
description: >
  Use this when working on UI or UX changes in the file-server project, especially for
  buttons, action hierarchy, dialogs, empty states, and visual consistency across
  Hono JSX + HTMX screens. It maps action roles to the shared style vocabulary and
  defers to AGENTS.md for the visual invariants.
---

# File Server Design

## Overview

Use this skill for UI-facing changes in `projects/file-server`.
It keeps visual changes aligned with the current product direction instead of making one-off styling decisions.

The visual invariants live in `AGENTS.md` → "UI Design"; that section is the source of truth for
color, surfaces, hairlines, radius, cursor/hover, toggle state, and the scroll container.
This skill covers what `AGENTS.md` does not: how to map an action to a role, which token in
`src/components/buttonStyles.ts` implements that role, and how to handle empty states, dialogs,
and the file viewer.

## When to Use This Skill

- When changing button styles, accent colors, or action hierarchy
- When editing dialogs, file viewer UI, list actions, or inline forms
- When adding or revising empty states, placeholders, helper text, or feedback copy
- When reviewing whether a UI change matches the existing visual language

## What the Agent Does

1. Inspect the affected UI and identify the action roles involved.
2. Read `AGENTS.md` → "UI Design" and `references/design-guidelines.md` before proposing or implementing visual changes.
3. Reuse the existing visual language unless there is an explicit request to change it.
4. Keep action roles consistent across list views, dialogs, and viewer states.
5. Preserve HTMX behavior, auth behavior, and path-safety constraints while changing presentation.
6. Add or update tests when UI output changes in a way the current test suite asserts.

## Input and Output

**Input:**
- A UI or UX change request in `projects/file-server`
- Existing Hono JSX components and HTML-based tests

**Output:**
- Consistent role decisions for the changed UI
- Updated components and tests that follow the shared style vocabulary

## Step Details

### Step 1: Read the Rules

Read `AGENTS.md` → "UI Design" first: it owns the visual invariants, and it wins over anything
in this skill or its reference.
Then open `references/design-guidelines.md` for the role vocabulary and the token that implements
each role.

### Step 2: Map Actions to Roles

For each changed control, decide whether it is:
- `primary`
- `secondary`
- `danger`
- `dismiss`
- `toggle`

Do not assign styles by feature name alone.
Assign them by user intent and risk level, then use the token listed in the reference.

### Step 3: Stay Inside the Vocabulary

Use `src/components/buttonStyles.ts` and `src/components/uiStyles.ts` instead of raw utility
strings, and compose base + tone + size rather than stacking conflicting utilities.
Do not add a second accent, a second palette, or a competing button vocabulary; if the existing
vocabulary cannot express the change, raise that as a question instead of inventing one locally.

### Step 4: Handle Empty States Explicitly

When content can be empty, show that emptiness intentionally.
Do not leave bordered panels, editors, or dialogs looking broken or unfinished.
See "Empty States" in the reference for the current copy and the drop-zone variant.

### Step 5: Protect Non-Visual Behavior

Do not break:
- HTMX targets, swaps, and push-url behavior
- file/path validation rules
- auth scope behavior
- current routes and API contracts

### Step 6: Update Tests

If HTML output or copy changes, update or add tests in `tests/` so the intended UX is locked in.

## Quality Check

- [ ] The change follows `AGENTS.md` → "UI Design"
- [ ] Each changed control uses the role token from the reference, not hand-rolled classes
- [ ] Destructive actions are not visually confused with close/cancel actions
- [ ] Empty content states are explicit, not silent blanks
- [ ] Existing HTMX and file-server behavior is preserved
- [ ] Tests cover new visible behavior when relevant

## References

- `AGENTS.md` → "UI Design" (source of truth for the visual invariants)
- `references/design-guidelines.md`
- `src/components/buttonStyles.ts`
- `src/components/uiStyles.ts`
- `src/components/FileList.tsx`
- `src/components/file-viewer/`
