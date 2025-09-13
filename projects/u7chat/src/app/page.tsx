'use client'

import { useState } from 'react'
import { generate } from './actions'
import { readStreamableValue } from '@ai-sdk/rsc'
import { Streamdown } from 'streamdown'

// Allow streaming responses up to 30 seconds
export const maxDuration = 30

export default function Home() {
  const [loading, setLoading] = useState(false)
  const [userInput, setUserInput] = useState('')
  const [generation, setGeneration] = useState('')

  return (
    <div className='flex min-h-screen flex-col items-center justify-center p-4'>
      <div className='flex w-full max-w-md flex-col gap-2'>
        <div className='flex max-h-[400px] flex-col gap-2 overflow-y-auto p-4'>
          {userInput && (
            <div className='flex justify-end'>
              <div className='rounded bg-gray-100 p-2 break-words whitespace-pre-wrap'>{userInput}</div>
            </div>
          )}
          <Streamdown className='break-words whitespace-pre-wrap'>{generation}</Streamdown>
        </div>
        <form
          className='flex gap-2'
          onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault()

            const prompt = `${new FormData(e.currentTarget).get('prompt')}`
            e.currentTarget.reset()
            setUserInput(prompt)
            setLoading(true)

            const { output } = await generate('gemini/gemini-2.5-flash', prompt)

            for await (const delta of readStreamableValue(output)) {
              setGeneration((currentGeneration) => `${currentGeneration}${delta}`)
            }
            setGeneration((currentGeneration) => `${currentGeneration}\n`)
            setLoading(false)
          }}
        >
          <input
            name='prompt'
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
      </div>
    </div>
  )
}
