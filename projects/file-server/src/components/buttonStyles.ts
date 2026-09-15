/**
 * Button vocabulary. Keep base, tone and size separate so call sites compose
 * them without stacking conflicting utilities (e.g. `px-4` on top of `px-6`).
 */

export const buttonBaseClassName =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"

const primaryToneClassName =
  "bg-indigo-600 text-white not-disabled:hover:bg-indigo-700"

export const secondaryToneClassName =
  "bg-white text-slate-700 ring-1 ring-slate-300 not-disabled:hover:bg-slate-50 not-disabled:hover:text-slate-900"

const ghostToneClassName =
  "text-slate-600 not-disabled:hover:bg-slate-100 not-disabled:hover:text-slate-900"

const dangerToneClassName =
  "text-slate-500 not-disabled:hover:bg-red-50 not-disabled:hover:text-red-600"

const mdSizeClassName = "px-4 py-2 text-sm"

export const smSizeClassName = "px-3 py-1.5 text-sm"

const iconSizeClassName = "h-9 w-9 p-0"

const iconSmSizeClassName = "h-8 w-8 p-0"

export const primaryButtonClassName = `${buttonBaseClassName} ${primaryToneClassName} ${mdSizeClassName}`

export const secondaryButtonClassName = `${buttonBaseClassName} ${secondaryToneClassName} ${mdSizeClassName}`

export const dismissButtonClassName = `${buttonBaseClassName} ${ghostToneClassName} ${mdSizeClassName}`

export const compactSecondaryButtonClassName = `${buttonBaseClassName} ${secondaryToneClassName} ${smSizeClassName}`

export const compactDangerButtonClassName = `${buttonBaseClassName} ${dangerToneClassName} ${smSizeClassName}`

export const secondaryIconButtonClassName = `${buttonBaseClassName} ${secondaryToneClassName} ${iconSizeClassName}`

export const dismissIconButtonClassName = `${buttonBaseClassName} ${ghostToneClassName} ${iconSizeClassName}`

export const dangerIconButtonClassName = `${buttonBaseClassName} ${dangerToneClassName} ${iconSmSizeClassName}`

/** Row action button: icon-only on narrow screens, icon + label from `md`. */
export const rowActionToggleClassName = `${buttonBaseClassName} ${secondaryToneClassName} h-8 w-8 p-0 text-sm md:w-auto md:px-3 aria-expanded:bg-indigo-50 aria-expanded:text-indigo-700 aria-expanded:ring-indigo-300 aria-expanded:not-disabled:hover:bg-indigo-100`

/** Toolbar toggle; state is driven by `aria-pressed` rather than class juggling. */
export const toggleButtonIdleClassName = `${buttonBaseClassName} ${secondaryToneClassName} ${smSizeClassName} w-full min-w-0 whitespace-nowrap sm:w-auto aria-pressed:bg-indigo-50 aria-pressed:text-indigo-700 aria-pressed:ring-indigo-300 aria-pressed:not-disabled:hover:bg-indigo-100`
