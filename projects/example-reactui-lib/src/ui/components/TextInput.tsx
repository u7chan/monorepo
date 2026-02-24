import React from 'react'

type TextInputProps = {
  id?: string
  type?: React.HTMLInputTypeAttribute
  value?: string
  placeholder?: string
  onChange?: (value: string) => void
}

export const TextInput: React.FC<TextInputProps> = ({ id, type = 'text', value, placeholder, onChange }) => {
  return (
    <input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />
  )
}
