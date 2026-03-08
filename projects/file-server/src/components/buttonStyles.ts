export const buttonBaseClassName =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all"

export const primaryButtonClassName = `${buttonBaseClassName} border-none bg-gradient-to-r from-indigo-500 to-purple-500 px-4 py-2 text-white hover:from-indigo-600 hover:to-purple-600`

export const secondaryButtonClassName = `${buttonBaseClassName} border-2 border-indigo-200 bg-white px-4 py-2 text-indigo-700 hover:border-purple-400 hover:bg-purple-50 hover:text-purple-700`

export const dismissButtonClassName = `${buttonBaseClassName} border border-slate-200 bg-slate-100 px-4 py-2 text-slate-700 hover:bg-slate-200`

export const dangerButtonClassName = `${buttonBaseClassName} border-none bg-gradient-to-r from-red-500 to-pink-500 px-4 py-2 text-white hover:from-red-600 hover:to-pink-600`

export const toggleButtonBaseClassName = `${secondaryButtonClassName} w-full min-w-0 whitespace-nowrap px-3 py-2 text-sm sm:w-auto sm:px-4 sm:text-base`

export const toggleButtonIdleClassName = toggleButtonBaseClassName

export const toggleButtonActiveClassName = `${toggleButtonBaseClassName} ring-2 ring-purple-400 bg-purple-50 border-purple-300 text-purple-700`

export const iconButtonBaseClassName =
  "h-10 w-12 rounded-xl text-base shadow-sm inline-flex items-center justify-center"

export const secondaryIconButtonClassName = `${secondaryButtonClassName} ${iconButtonBaseClassName} px-0`

export const dismissIconButtonClassName = `${dismissButtonClassName} ${iconButtonBaseClassName} px-0`

export const dangerIconButtonClassName = `${dangerButtonClassName} h-8 w-8 cursor-pointer px-0 transform rounded-lg transition-all hover:scale-105`
