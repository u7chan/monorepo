interface Props {
  label: string
  value: boolean
  disabled: boolean
  onClick: () => void
}

export function ToggleInput({ label, value, disabled, onClick }: Partial<Props>) {
  return (
    <div className='flex items-center justify-between gap-2'>
      <span className='ml-1 text-md'>{label}</span>
      <button
        type='button'
        disabled={disabled}
        className={`flex h-8 w-14 cursor-pointer items-center rounded-full p-1 transition-colors duration-300 ${
          value ? 'bg-blue-500' : 'bg-gray-400'
        }`}
        onClick={onClick}
      >
        <div
          className={`h-6 w-6 transform rounded-full bg-white shadow-md transition-transform duration-300 ${
            value ? 'translate-x-6' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}
