'use client'

import { changeStream } from './actions'

interface StreamToggleProps {
  defaultValue?: boolean
}

export function StreamToggle({ defaultValue }: StreamToggleProps) {
  return (
    <div className='flex items-center gap-2'>
      <label htmlFor='stream'>Stream:</label>
      <input
        id='stream'
        type='checkbox'
        defaultChecked={defaultValue}
        onChange={(e) => {
          changeStream(e.target.checked)
        }}
      />
    </div>
  )
}
