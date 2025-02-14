import { DeepSeekProvider } from './DeepSeekProvider'
import { OpenAIProvider } from './OpenAIProvider'
import { TestProvider } from './TestProvider'
import type { LLMProvider } from './types'

export function getLLMProvider(
  llm: 'openai' | 'deepseek' | 'test',
  envs: {
    OPENAI_API_KEY?: string
    DEEPSEEK_API_KEY?: string
  },
): LLMProvider {
  switch (llm) {
    case 'openai':
      if (!envs.OPENAI_API_KEY) {
        throw new Error('The OPENAI_API_KEY key for the environment variable is not set.')
      }
      return new OpenAIProvider(envs.OPENAI_API_KEY)

    case 'deepseek':
      if (!envs.DEEPSEEK_API_KEY) {
        throw new Error('The DEEPSEEK_API_KEY key for the environment variable is not set.')
      }
      return new DeepSeekProvider(envs.DEEPSEEK_API_KEY)

    case 'test':
      return new TestProvider()

    default:
      throw new Error(`Unsupported LLM: ${llm}`)
  }
}
