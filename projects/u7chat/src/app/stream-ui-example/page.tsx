'use client'
import { useState } from 'react'
import { streamComponent } from './actions'

export default function Page() {
  const [component, setComponent] = useState<React.ReactNode>()

  return (
    <div>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setComponent(await streamComponent())
        }}
      >
        <button className='rounded border border-gray-300 bg-white p-2'>Stream Component</button>
      </form>
      <div>{component}</div>
    </div>
  )
}
