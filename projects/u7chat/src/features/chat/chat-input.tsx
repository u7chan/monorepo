'use client'

interface ChatInputProps {
  loading: boolean
  onSubmit: (user: string) => Promise<void>
}

export function ChatInput({ loading, onSubmit }: ChatInputProps) {
  return (
    <form
      className='flex gap-2'
      onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        onSubmit(`${new FormData(e.currentTarget).get('input')}`)
        e.currentTarget.reset()
      }}
    >
      <input
        name='input'
        type='text'
        className='flex-1 rounded border border-gray-300 p-2'
        required
        autoComplete='off'
      />
      <button
        type='submit'
        className='rounded bg-blue-500 px-4 py-2 text-white enabled:cursor-pointer enabled:hover:bg-blue-600 disabled:opacity-50'
        disabled={loading}
      >
        Ask
      </button>
    </form>
  )
}
