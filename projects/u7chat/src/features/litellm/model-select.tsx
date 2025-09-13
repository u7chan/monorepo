'use client'

import { changeModel } from './litellm-actions'

export function ModelSelect(props: { models: string[]; defaultModel?: string }) {
  console.log('Default model:', props.defaultModel)
  return (
    <select
      className='mb-4 w-full rounded border border-gray-300 p-2'
      onChange={(e) => {
        changeModel(e.target.value)
      }}
      defaultValue={props.defaultModel}
    >
      {props.models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  )
}
