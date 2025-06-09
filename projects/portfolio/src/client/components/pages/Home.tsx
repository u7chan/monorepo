import type { AppType } from '@/server/app.d'
import { hc } from 'hono/client'
import { type FormEvent, useState } from 'react'

const client = hc<AppType>('/')

export function Home() {
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    client.api.signin
      .$post({
        json: { email, password },
      })
      .then((res) => {
        if (!res.ok) {
          setError('メールアドレスまたはパスワードが正しくありません。')
          return
        }
      })
  }

  return (
    <div className='flex min-h-screen items-center justify-center px-4'>
      <div className='w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8'>
        <h2 className='mb-6 text-center font-bold text-2xl'>Home</h2>

        <form onSubmit={handleSubmit} className='space-y-4'>
          {error && <div className='mb-2 rounded bg-red-100 p-3 text-red-700 text-xs'>{error}</div>}
          <div>
            <label htmlFor='email' className='mb-1 block font-semibold text-gray-700 text-sm'>
              Email
            </label>
            <input
              id='email'
              name='email'
              type='email'
              required
              className='w-full rounded border px-3 py-2 transition-colors hover:border-primary-700 focus:outline-hidden'
            />
          </div>

          <div>
            <label htmlFor='password' className='mb-1 block font-semibold text-gray-700 text-sm'>
              Password
            </label>
            <input
              id='password'
              name='password'
              type='password'
              required
              className='w-full rounded border px-3 py-2 transition-colors hover:border-primary-700 focus:outline-hidden'
            />
          </div>

          <button
            type='submit'
            className='mt-2 w-full cursor-pointer rounded-sm bg-primary-800 p-2 text-white hover:bg-primary-700'
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  )
}
