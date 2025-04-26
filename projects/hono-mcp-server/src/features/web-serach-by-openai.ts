import OpenAI from 'openai'

const openai = new OpenAI()

export async function webSerachByOpenAI(content: string): Promise<string> {
  // Call OpenAI API to web serach the text
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini-search-preview',
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    web_search_options: {
      search_context_size: 'low',
      user_location: {
        type: 'approximate',
        approximate: {
          country: 'JP',
          region: 'Tokyo',
          timezone: 'Asia/Tokyo',
        },
      },
    },
  })
  return response.choices[0].message.content || ''
}
