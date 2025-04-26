import OpenAI from 'openai'

const openai = new OpenAI()

export async function webSerachByOpenAI(input: string): Promise<string> {
  console.info('» [webSerachByOpenAI] input:', input)
  // Call OpenAI API to web serach the text
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini-search-preview',
    messages: [
      {
        role: 'user',
        content: input,
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
  const output = response.choices[0].message.content || ''
  console.info('» [webSerachByOpenAI] output:', output)
  return output
}
