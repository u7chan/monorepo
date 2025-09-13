'use client'

import { changeModel } from './llm-model-actions'

export function ModelSelect(props: { models: string[]; defaultModel?: string }) {
  return (
    <select
      className='mb-4 w-full rounded border border-gray-300 p-2'
      onChange={(e) => {
        changeModel(e.target.value)
      }}
      defaultValue={props.defaultModel}
      required
    >
      <option value=''></option>
      {props.models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  )
}
