import { type ChangeEvent } from 'react'

interface Props {
  name: string
  label: string
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'password' | 'number'
  min?: number
  max?: number
  suffix?: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}

export function TextInput({
  name,
  label,
  defaultValue,
  placeholder,
  disabled = false,
  type = 'text',
  min,
  max,
  suffix,
  onChange,
}: Props) {
  return (
    <div className='space-y-2'>
      <label className={`block text-sm font-medium ${disabled ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}>
        {label} {suffix && <span className='text-xs text-gray-500'>{suffix}</span>}
      </label>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={onChange}
        placeholder={placeholder}
        min={min}
        max={max}
        className={`w-full rounded-md border px-3 py-2 text-sm outline-none transition-all ${
          disabled
            ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
            : 'border-gray-300 bg-white text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
        }`}
      />
    </div>
  )
}
