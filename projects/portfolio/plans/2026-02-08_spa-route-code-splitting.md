# SPA Route-Level Code Splitting (TanStack Router)

## Background

- Frontend is a React SPA served by the Hono server (`src/server/app.tsx`).
- Server uses a wildcard route (`.get('*', ...)`) to always return the SPA HTML shell; routing is handled client-side.
- Bundle size is growing; want to split bundles per page/route to reduce initial load and make optimization manageable.
- TanStack Router is currently used; it may be removed in the future, but navigation behavior may still be kept.

## Goal / Success Criteria

- Initial JS downloaded/executed for `/` is smaller than today.
- Heavy pages (notably `/diff` with Monaco and `/chat`) are not included in the initial bundle and load only when visited.
- Client-side navigation still works: `/`, `/about`, `/diff`, `/chat`.
- A simple, global loading UI appears during route chunk loading.
- No change to server routing behavior (still wildcard SPA shell).

## Current Repo Notes (as of 2026-02-08)

- Router entry: `src/client/main.tsx` uses `createRouter({ routeTree })` and `RouterProvider`.
- Route files: `src/client/routes/*` import page components from `src/client/pages/*`.
- Vite config: `vite.config.ts` builds with a single JS entry name `client.js` (additional chunks allowed).

## Plan (Implementation Details)

### 1) Add a global route loading component

Create:

- `src/client/components/route-loading.tsx`

Behavior:

- Centered spinner + short text (optional).
- Reuse existing `SpinnerIcon` (`src/client/components/svg/spinner-icon.tsx`) to avoid new assets.

### 2) Wrap the route outlet with Suspense in the root route

Update:

- `src/client/routes/__root.tsx`

Change:

- Wrap `<Outlet />` with:
  - `import { Suspense } from 'react'`
  - `<Suspense fallback={<RouteLoading />}>`

Rationale:

- Centralize loading UI and keep route files minimal.

### 3) Lazy-load page components per route

Update:

- `src/client/routes/index.tsx`
- `src/client/routes/about.tsx`
- `src/client/routes/diff.tsx`
- `src/client/routes/chat.tsx`

Change pattern:

- Replace static page imports with `React.lazy`.
- Because pages are named exports (e.g. `export function Diff()`), map them to a default export:
  - `lazy(() => import('#/client/pages/diff').then((m) => ({ default: m.Diff })))`

Expected impact:

- `/diff` chunk isolates Monaco (`@monaco-editor/react`) and related code.
- `/chat` chunk isolates chat UI and its dependencies.

### 4) Verify outputs and behavior

Commands:

- `bun run build`
- `bun run dev`

Checks:

- In `dist/static`, confirm additional JS chunks exist besides `client.js`.
- In devtools Network tab:
  - Visiting `/` does not load Monaco-related chunks.
  - Navigating to `/diff` triggers a chunk request and shows the global loader briefly.
- Direct navigation (hard refresh) to `/diff` and `/chat` still works because server returns the SPA shell for all paths.

## Non-Goals (for this task)

- Converting to MPA (multiple HTML entries) or server-side rendering.
- Replacing TanStack Router.
- Advanced bundler tuning (manualChunks, vendor splitting strategy, etc.) beyond route-level lazy loading.

## Follow-ups (Optional)

- Add route prefetch on hover/focus for sidebar links (if desired).
- Add a bundle visualizer step to quantify improvement (e.g. Rollup visualizer) and track regressions.
- If TanStack Router is removed later:
  - Keep the same lazy-loaded pages and wrap them behind the new router/navigation layer.
