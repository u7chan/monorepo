interface Props {
  label?: string
  labelClassName?: string
  value?: boolean
  disabled?: boolean
  onClick?: () => void
}

export function ToggleInput({ label, labelClassName, value, disabled, onClick }: Props) {
  const trackClassName = disabled
    ? value
      ? 'cursor-not-allowed bg-primary-200 dark:bg-primary-900/40'
      : 'cursor-not-allowed bg-gray-200 dark:bg-gray-700'
    : value
      ? 'cursor-pointer bg-primary-800 dark:bg-primary-600'
      : 'cursor-pointer bg-gray-400 dark:bg-gray-600'

  const thumbClassName = disabled ? 'bg-gray-50 shadow-sm dark:bg-gray-300' : 'bg-white shadow-md dark:bg-gray-200'

  return (
    <div className='flex items-center justify-between gap-2'>
      {label && (
        <span className={`shrink-0 font-medium text-gray-900 text-sm dark:text-gray-200 ${labelClassName || ''}`}>
          {label}
        </span>
      )}
      <button
        type='button'
        disabled={disabled}
        className={`flex h-8 w-14 items-center rounded-full p-1 transition-colors duration-300 ${trackClassName}`}
        onClick={onClick}
      >
        <div
          className={`h-6 w-6 transform rounded-full transition-transform duration-300 ${thumbClassName} ${
            value ? 'translate-x-6' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}
