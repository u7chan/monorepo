# File Server Design Guidelines

## Purpose

These guidelines define the current design direction for `projects/file-server`.
Use them when making UI changes so the interface evolves coherently.

## Visual Direction

- Keep the existing soft indigo, purple, and pink palette used by the page shell.
- Keep rounded corners and lightly elevated containers.
- Use gradients as accents, not as the default style for every action.
- Prefer a calm base UI with a few intentional highlights.

## Button Semantics

Map every action to one of these roles before choosing styles.

### Primary

Use for the main commit action in the current context.

Style direction:
- indigo-to-purple gradient
- white text
- stronger visual weight than surrounding controls

Typical examples:
- `Create File`
- `Create Folder`
- editor `Save`

Rule:
- In a single local action group, avoid multiple primary buttons unless they are truly equivalent submit actions.

### Secondary

Use for non-destructive utility actions and entry points.

Style direction:
- white or lightly tinted surface
- indigo border/text
- hover tint instead of a full gradient

Typical examples:
- `New File`
- `New Folder`
- `Download Zip`
- modal `Download`
- modal `Edit`
- list `Rename`

Rule:
- A feature should not become primary only because it is new or visually prominent.

### Danger

Use only for destructive actions.

Style direction:
- red or rose treatment
- must be clearly distinguishable from close/cancel

Typical examples:
- `Delete`

Rule:
- Do not use danger styling for navigation, dismissal, or non-destructive exits.

### Dismiss

Use for leaving or backing out of the current state without destructive effect.

Style direction:
- neutral gray or other low-emphasis treatment
- visually quieter than primary and danger

Typical examples:
- modal `Close`
- rename `Cancel`
- editor `Cancel`

Rule:
- Close and cancel must never look like delete.

## Active and Toggle States

- For accordion triggers or toggleable utility buttons, show active state with ring, border, or tint changes.
- Do not give one toggle a permanent primary treatment if it is only one of several peer actions.
- When toggling between forms, use the same active-state language for both options.

## Dialog and Viewer Rules

- Modal toolbar buttons must use the same role semantics as list actions.
- Keep title styling and container treatment aligned with the page shell palette.
- Avoid mixing unrelated accent colors for peer actions in the same toolbar.

## Empty States

- Empty content should look intentional.
- In read mode, show a short empty-state message inside the viewer instead of an empty framed box.
- In edit mode, use a placeholder when the editable text is empty.
- Empty-state copy should be short, calm, and in English unless the product language changes.

Suggested phrasing:
- `This file is empty.`
- `This file is empty. Start typing...`

## Scope Boundaries

- These rules apply to the file browsing and file viewer experience first.
- Auth pages can remain simpler unless a task explicitly includes them.
- Preserve current HTMX structure and server-side rendering patterns while adjusting presentation.

## Implementation Notes

- Prefer a lightweight shared class helper or style constant when multiple controls share the same role.
- Avoid large design-system abstractions unless the task clearly justifies them.
- If tests assert HTML output, update them alongside the UI change.
