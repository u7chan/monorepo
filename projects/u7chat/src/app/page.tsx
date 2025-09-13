'use client'

import { useState } from 'react'
import { generate } from './actions'
import { readStreamableValue } from '@ai-sdk/rsc'
import { Streamdown } from 'streamdown'

// Allow streaming responses up to 30 seconds
export const maxDuration = 30

export default function Home() {
  const [loading, setLoading] = useState(false)
  const [generation, setGeneration] = useState<string>('')

  return (
    <div className='flex min-h-screen flex-col items-center justify-center p-4'>
      <button
        className='rounded bg-blue-500 px-4 py-2 text-white enabled:cursor-pointer enabled:hover:bg-blue-600 disabled:opacity-50'
        disabled={loading}
        onClick={async () => {
          setLoading(true)
          const { output } = await generate(
            'gemini/gemini-2.5-flash',
            'Who are you? Show simple markdown syntax example',
          )

          for await (const delta of readStreamableValue(output)) {
            setGeneration((currentGeneration) => `${currentGeneration}${delta}`)
          }
          setLoading(false)
        }}
      >
        Ask
      </button>
      <Streamdown>{generation}</Streamdown>
    </div>
  )
}
