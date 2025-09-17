'use client'

interface ChatInputProps {
  loading: boolean
  onSubmit: (user: string) => Promise<void>
}

export function ChatInput({ loading, onSubmit }: ChatInputProps) {
  return (
    <form
      className='border-border relative flex rounded-3xl border pb-12'
      onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        onSubmit(`${new FormData(e.currentTarget).get('input')}`)
        e.currentTarget.reset()
      }}
    >
      <textarea
        name='input'
        rows={2}
        className='min-h-10 flex-1 p-4 ring-0 focus:ring-0 focus:outline-none'
        required
      ></textarea>
      <button
        type='submit'
        className='absolute right-0.5 bottom-0.5 flex h-12 w-12 items-center justify-center enabled:cursor-pointer'
        disabled={loading}
      >
        <div className='border-border flex h-9 w-9 items-center justify-center rounded-4xl border'>
          <svg viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' width='24' height='24'>
            <path
              d='M12 20V4m0 0l-6 6m6-6l6 6'
              className='stroke-foreground'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          </svg>
        </div>
      </button>
    </form>
  )
}
