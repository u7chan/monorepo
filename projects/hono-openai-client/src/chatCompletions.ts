import OpenAI from 'openai'

export async function chatCompletions(
  input: string
): Promise<{ model: string; content: string }> {
  const openai = new OpenAI({
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  })
  const completion = await openai.chat.completions.create({
    model: process.env.MODEL || '',
    messages: [
      {
        role: 'user',
        content: input,
      },
    ],
  })
  const { model, choices } = completion
  const { content } = choices[0].message
  return {
    model,
    content: content || '',
  }
}
