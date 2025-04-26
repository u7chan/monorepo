import OpenAI from 'openai'

const openai = new OpenAI()

export async function translateToEnglish(input: string): Promise<string> {
  console.info('» [translateToEnglish] input:', input)
  // Call OpenAI API to translate the text
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [
      {
        role: 'system',
        content:
          'You are a professional translator. Translate the following Japanese text to English while preserving the original meaning and nuance.',
      },
      {
        role: 'user',
        content: input,
      },
    ],
  })
  const output = response.choices[0].message.content || ''
  console.info('» [translateToEnglish] output:', output)
  return output
}
