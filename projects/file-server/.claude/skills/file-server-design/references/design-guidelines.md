# File Server Design Guidelines

## Purpose

How to map an action to a role in `projects/file-server`, and which shared token implements that role.

## Relationship to AGENTS.md

`AGENTS.md` → "UI Design" is the source of truth for the visual invariants: accent color,
surfaces and their nesting, hairlines, radius scale, cursor/hover, toggle state, and the scroll
container bleed.
This document does not restate or override those rules. It only adds what `AGENTS.md` does not
cover: the role vocabulary, the token that implements each role, and the handling of empty states,
dialogs, and the viewer.

If this document and `AGENTS.md` ever disagree, `AGENTS.md` wins and this document is the part
that has to be fixed.

## Style Vocabulary

Use the shared tokens instead of raw utility strings:

- `src/components/buttonStyles.ts` — button base, tone, and size tokens
- `src/components/uiStyles.ts` — surfaces, fields, alerts, badges, text

Compose base + tone + size. Do not stack conflicting utilities (such as `px-4` on top of `px-6`).

## Button Semantics

Map every action to one of the roles below before choosing styles, then reach for the token.
The tokens are the definition of the role; the examples show how they are already used.

### Primary

- Token: `primaryButtonClassName`
- Intent: the commit action of the current context. One per local action group unless the buttons are truly equivalent submits.
- Tone: solid `bg-indigo-600` with white text.
- Examples: `Create File`, `Create Folder`, rename `Save`, move picker `Move here`, `Login`, user management `Create User` / `Change`.
- Rule: a feature does not become primary by being new or visually prominent.

### Secondary

- Tokens: `secondaryButtonClassName`, `compactSecondaryButtonClassName`, `secondaryIconButtonClassName`
- Intent: non-destructive utility actions and entry points.
- Tone: white surface, `text-slate-700`, hairline `ring-1 ring-slate-300`, hover `bg-slate-50`.
- Examples: `Open as text`, admin `← Back`, `User Management`, `Change Role` / `Reset PW`, viewer `Download` / `Open public URL` / `Edit` / `Copy`.
- Rule: secondary is the default for new utility actions. Do not promote one to primary for emphasis.

### Danger

- Tokens: `compactDangerButtonClassName`, `dangerIconButtonClassName`
- Intent: destructive actions only.
- Tone: neutral `text-slate-500` at rest; `bg-red-50` with `text-red-600` on hover. Red is the hover state, not the resting state.
- Examples: file row `Delete`, admin row `Delete`.
- Rule: never use danger styling for navigation, dismissal, or non-destructive exits.

### Dismiss

- Tokens: `dismissButtonClassName`, `dismissIconButtonClassName`
- Intent: leaving or backing out of the current state without destructive effect.
- Tone: quiet `text-slate-600`, hover `bg-slate-100`.
- Examples: viewer `Close`, rename `Cancel`, editor `Cancel`, move picker `Cancel`.
- Rule: close and cancel must never look like delete.

### Toggle

- Tokens: `toggleButtonIdleClassName` (`aria-pressed`), `rowActionToggleClassName` (`aria-expanded`)
- Intent: a control that opens/closes a form, selects something, or expands a row action.
- Tone: the secondary tone at rest; the active state comes from ARIA variants (`aria-pressed:bg-indigo-50 aria-pressed:text-indigo-700 aria-pressed:ring-indigo-300`, and the same for `aria-expanded`).
- Examples: `New File`, `New Folder` (toolbar toggles), `Download Zip` (toolbar link that borrows the same idle tone), file row `Move` / `Rename`.
- Rule: keep the state in the ARIA attribute and let Tailwind variants express it. Do not add or remove class names from JavaScript, and do not give one peer toggle a permanent primary look.
- Selection is the one place where the primary tone marks an active item: the move picker's root button uses the primary tone for the current root and the secondary tone for the others.

`<a>`-based actions reuse the same tokens, so a link and a button with the same role look identical.

## Dialog and Viewer Rules

- A modal toolbar uses the same role tokens as list actions. Do not invent modal-only styles.
- The viewer toolbar is a group of secondary icon buttons plus one dismiss icon button at the end; keep them in that order so the dismissal stays distinguishable.
- Inline forms opened inside a row follow the `primary` + `dismiss` pair (`Save` / `Cancel`).
- Keep the file viewer's preview/edit/view-state behavior unchanged when restyling; the role tokens only change the chrome.

## Empty States

- Empty content should look intentional. Never leave a bordered panel, editor, or dialog as a silent blank.
- List: an empty directory shows a centered empty-state message instead of rows. When upload is possible it doubles as the drop target, so the copy describes the action (`Drop files here to upload`); otherwise it states the state (`This directory is empty.`).
- Viewer: read mode shows `This file is empty.` in the content area; edit mode uses the placeholder `This file is empty. Start typing...`.
- Keep empty-state copy short, calm, and in English unless the product language changes.

## Scope Boundaries

- These rules apply to the file browsing and file viewer experience first.
- Auth and admin screens reuse the same tokens; keep them simpler unless a task explicitly includes them.
- Preserve current HTMX structure and server-side rendering patterns while adjusting presentation.
- Documents under `plans/` (including `plans/old/`) are dated historical records. They can describe
  superseded palettes such as gradients or purple accents; never treat them as current design policy.

## Implementation Notes

- Prefer a lightweight shared class helper or style constant when multiple controls share the same role.
- Avoid large design-system abstractions unless the task clearly justifies them.
- If tests assert HTML output, update them alongside the UI change.
