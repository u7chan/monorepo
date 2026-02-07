# Refactor API Handlers in src/index.tsx

**Priority:** High  
**Category:** Code Organization

## Task

Refactor the API handler logic in `src/index.tsx` to reduce duplication and improve readability.

## Requirements

- Extract common request utilities (upload dir, request path, HX request detection)
- Centralize path validation and stat/not-found handling
- Simplify HTML response rendering (full shell vs partial)
- Split routing into dedicated route modules where appropriate
- Reduce branching complexity in `/file` handler

## Acceptance Criteria

- [x] Shared helpers added in a dedicated util module
- [x] `/`, `/browse`, `/file`, `/file/raw` handlers use shared helpers
- [x] Routing is split into modules (browse/file/api) and composed in `src/index.tsx`
- [x] No change in public behavior (same responses for same inputs)
- [x] Code in `src/index.tsx` is significantly shorter and readable
