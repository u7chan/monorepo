'use client'

interface ChatInputProps {
  loading: boolean
  onSubmit: (user: string) => Promise<void>
}

export function ChatInput({ loading, onSubmit }: ChatInputProps) {
  return (
    <form
      className='relative flex rounded-2xl border border-gray-300 pb-12'
      onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        onSubmit(`${new FormData(e.currentTarget).get('input')}`)
        e.currentTarget.reset()
      }}
    >
      <textarea
        name='input'
        rows={2}
        className='min-h-10 flex-1 p-2 ring-0 focus:ring-0 focus:outline-none'
        required
      ></textarea>
      <button
        type='submit'
        className='absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-4xl bg-slate-500 text-white enabled:cursor-pointer enabled:hover:opacity-80 disabled:opacity-50 dark:bg-slate-700'
        disabled={loading}
      >
        <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' width='24' height='24'>
          <path
            d='M12 20V4m0 0l-6 6m6-6l6 6'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          />
        </svg>
      </button>
    </form>
  )
}
