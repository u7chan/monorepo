'use server'

import { streamUI } from '@ai-sdk/rsc'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

const LoadingComponent = () => <div className='animate-pulse p-4'>getting weather...</div>

const getWeather = async (location: string) => {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  return '82°F️ ☀️'
}

interface WeatherProps {
  location: string
  weather: string
}

const WeatherComponent = (props: WeatherProps) => (
  <div className='max-w-fit rounded-lg border border-neutral-200 p-4'>
    The weather in {props.location} is {props.weather}
  </div>
)

export async function streamComponent() {
  const openai = createOpenAI({
    baseURL: process.env.LITELLM_API_BASE_URL!,
    apiKey: process.env.LITELLM_API_KEY!,
  })
  const result = await streamUI({
    model: openai('gpt-4.1-nano'),
    prompt: 'Get the weather for San Francisco',
    text: ({ content }) => <div>{content}</div>,
    tools: {
      getWeather: {
        description: 'Get the weather for a location',
        inputSchema: z.object({
          location: z.string(),
        }),
        generate: async function* ({ location }) {
          yield <LoadingComponent />
          const weather = await getWeather(location)
          return <WeatherComponent weather={weather} location={location} />
        },
      },
    },
  })

  return result.value
}
