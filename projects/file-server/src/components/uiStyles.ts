/**
 * Shared class vocabulary for the file-server UI.
 *
 * Invariants this file encodes:
 * - One accent color (indigo) for emphasis. Surfaces and text stay neutral (slate).
 * - Hierarchy comes from spacing, dividers and surface differences, not from
 *   nesting another bordered box inside a bordered box.
 * - Hairline separation only (`border` / `ring-1`); avoid `border-2` framing.
 * - Radius scale: `rounded-lg` for controls and inset panels, `rounded-xl` for
 *   floating surfaces, `rounded-2xl` for the page shell.
 */

/** Floating surface (modal, sheet). */
export const modalSurfaceClassName =
  "rounded-xl bg-white shadow-lg ring-1 ring-slate-900/5"

/** Inset panel inside a surface (inline forms). */
export const insetPanelClassName = "rounded-lg bg-slate-50"

export const fieldClassName =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"

export const compactFieldClassName =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"

export const labelClassName = "mb-1 block text-sm font-medium text-slate-700"

export const badgeClassName =
  "inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tracking-wide text-slate-600 uppercase ring-1 ring-slate-200"

/** Vertical hairline between a quiet label group and the controls next to it. */
export const verticalDividerClassName = "h-5 w-px shrink-0 bg-slate-200"

export const mutedTextClassName = "text-sm text-slate-500"

export const sectionTitleClassName = "text-sm font-semibold text-slate-800"

export const sectionClassName = "border-t border-slate-200 pt-5"

export const alertErrorClassName =
  "rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 ring-1 ring-red-100"

export const alertSuccessClassName =
  "rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-100"

export const breadcrumbLinkClassName =
  "rounded px-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-indigo-600"
