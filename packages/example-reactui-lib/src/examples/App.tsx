import { useState } from 'react'
import { TextInput } from '../ui/components/TextInput'
import { Button } from '../ui/components/Button'

export function App() {
  const [combinedText, setCombinedText] = useState('default')
  const [inputText, setInputText] = useState('')

  const handleAdd = () => {
    if (!inputText.trim()) return
    setCombinedText((prev) => prev + inputText)
    setInputText('')
  }

  return (
    <>
      <p>{combinedText}</p>
      <hr />
      <label htmlFor='input-text' style={{ display: 'block', marginBottom: 8 }}>
        Input Text:
      </label>
      <TextInput
        id='input-text'
        value={inputText}
        onChange={(value: string) => setInputText(value)}
        placeholder='Type something'
      />
      <Button onClick={handleAdd}>Add</Button>
    </>
  )
}
