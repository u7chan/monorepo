import OpenAI from 'openai'

interface Result {
  model: string
  content: string
}

export async function chatCompletions(input: string): Promise<Result> {
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
  return {
    model,
    content: choices[0].message.content || '',
  }
}

export async function chatCompletionsStream(
  input: string,
  onStream: (chunk: Result) => Promise<void>
) {
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
    stream: true,
  })
  for await (const chunk of completion) {
    const { model, choices } = chunk
    onStream({
      model,
      content: choices[0].delta.content || '',
    })
  }
}
