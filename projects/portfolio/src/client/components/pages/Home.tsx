import { useState } from 'react'

export function Home() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
  }
  return (
    <div className='flex min-h-screen items-center justify-center px-4'>
      <div className='w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8'>
        <h2 className='mb-6 text-center font-bold text-2xl'>Home</h2>

        <form onSubmit={handleSubmit} className='space-y-4'>
          <div>
            <label htmlFor='email' className='mb-1 block font-semibold text-gray-700'>
              Email
            </label>
            <input
              id='email'
              type='email'
              required
              className='w-full rounded border px-3 py-2 transition-colors hover:border-primary-700 focus:outline-hidden'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder='example@mail.com'
            />
          </div>

          <div>
            <label htmlFor='password' className='mb-1 block font-semibold text-gray-700'>
              Password
            </label>
            <input
              id='password'
              type='password'
              required
              className='w-full rounded border px-3 py-2 transition-colors hover:border-primary-700 focus:outline-hidden'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder='••••••••'
            />
          </div>

          <button
            type='submit'
            className='w-full cursor-pointer rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700'
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  )
}
