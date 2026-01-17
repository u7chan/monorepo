import { readFromLocalStorage, saveToLocalStorage } from '#/client/components/chat/remoteStorageSettings'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { useMemo, useState } from 'react'

interface PromptTemplate {
  id: string
  inputType: 'text' | 'textarea'
  title: string
  placeholder: string
  prompt: string
}

const promptTemplates: PromptTemplate[] = [
  {
    id: 'translate_en',
    inputType: 'textarea',
    title: '🇺🇸 英語へ翻訳',
    placeholder: '例: これを英語で言うと？',
    prompt: `
You are an English translation assistant.
Please accurately and naturally translate the user's input text from Japanese into English.
Use the very last user input in the system prompt.`.trim(),
  },
  {
    id: 'translate_ja',
    inputType: 'textarea',
    title: '🇯🇵 日本語へ翻訳',
    placeholder: '例: How do you say this in Japanese?',
    prompt: `
You are a Japanese translation assistant.
Please accurately and naturally translate the user's input text into Japanese.
Use the very last user input in the system prompt.`.trim(),
  },
  {
    id: 'commit_message',
    inputType: 'text',
    title: '📝 コミットメッセージを作成',
    placeholder: '例: ユーザー登録機能を追加',
    prompt: `
You are a Assistant to create commit messages.
Summarizes the input and produces an English sentence of appropriate length for the commit message.
Please enclose the English sentences in triple backtick code blocks when outputting.
Be sure to translate the output English into Japanese again with a new line and output it in “Japanese”.
Use the very last user input in the system prompt.`.trim(),
  },
  {
    id: 'text_summarization',
    inputType: 'textarea',
    title: '✍️ 文章を校正',
    placeholder: '例: 入力した文章を校正します',
    prompt: `
You are an expert proofreader.
Please carefully edit the following text for spelling, grammar, punctuation, and sentence structure errors.
Correct any awkward or unnatural phrasing and improve clarity while preserving the original meaning and intent.
Provide the revised, polished version of the entire text.
Use the very last user input in the system prompt.`.trim(),
  },
] as const

export interface TemplateInput {
  model: string
  prompt: string
  content:
    | string
    | Array<
        | {
            type: 'text'
            text: string
          }
        | {
            type: 'image_url'
            image_url: {
              url: string
            }
          }
      >
}

interface Props {
  onSubmit?: (templateInput: TemplateInput) => void
}

export function PromptTemplate({ onSubmit }: Props) {
  const [composing, setComposition] = useState(false)

  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])

  const handleChangeComposition = (composition: boolean) => {
    setComposition(composition)
  }

  const handleChangeTemplateModel = (event: ChangeEvent<HTMLInputElement>, id: string) => {
    const pre = readFromLocalStorage().templateModels || {}
    saveToLocalStorage({
      templateModels: { ...pre, [id]: { model: event.target.value } },
    })
  }

  const handleKeyDownTemplate = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    { id, prompt }: PromptTemplate
  ) => {
    const content = event.currentTarget.value.trim()
    if (event.key === 'Enter' && !event.shiftKey && content && !composing) {
      event.preventDefault()
      const templateInput = {
        model: readFromLocalStorage()?.templateModels?.[id]?.model || '',
        prompt,
        content,
      }
      onSubmit?.(templateInput)
    }
  }
  return (
    <div className='hidden sm:block'>
      <div className='grid grid-cols-1 gap-3 p-4 sm:grid-cols-2'>
        {promptTemplates.map((template) => (
          <div
            key={template.title}
            className='rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-600 dark:bg-gray-800'
          >
            <div className='mb-2 flex items-center justify-between'>
              <div className='line-clamp-2 font-semibold text-gray-700 text-sm dark:text-gray-200'>
                {template.title}
              </div>
              <div className='flex items-center gap-2'>
                <div className='text-gray-500 text-xs dark:text-gray-400'>Model</div>
                <input
                  type='text'
                  spellCheck='false'
                  className='rounded-sm border p-1 text-gray-600 text-xs transition-colors hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200'
                  onChange={(e) => handleChangeTemplateModel(e, template.id)}
                  defaultValue={defaultSettings?.templateModels?.[template.id]?.model || ''}
                />
              </div>
            </div>
            <p className='text-gray-600 dark:text-gray-200'>
              {template.inputType === 'text' ? (
                <input
                  type='text'
                  spellCheck='false'
                  className='w-full rounded-sm border p-1 text-sm transition-colors hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200'
                  placeholder={template.placeholder}
                  onKeyDown={(e) => handleKeyDownTemplate(e, template)}
                  onCompositionStart={() => handleChangeComposition(true)}
                  onCompositionEnd={() => handleChangeComposition(false)}
                />
              ) : (
                <textarea
                  className='max-h-64 min-h-8 w-full rounded-sm border p-1 text-sm transition-colors hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-400'
                  placeholder={template.placeholder}
                  onKeyDown={(e) => handleKeyDownTemplate(e, template)}
                  onCompositionStart={() => handleChangeComposition(true)}
                  onCompositionEnd={() => handleChangeComposition(false)}
                />
              )}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
