'use client'

import { changeModel } from './actions'

interface ModelSelectProps {
  models: string[]
  defaultValue?: string
}

export function ModelSelect({ models, defaultValue }: ModelSelectProps) {
  return (
    <select
      className='w-full cursor-pointer appearance-none rounded border border-gray-300 p-2'
      onChange={(e) => {
        changeModel(e.target.value)
      }}
      defaultValue={defaultValue}
      required
    >
      <option value=''></option>
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  )
}
