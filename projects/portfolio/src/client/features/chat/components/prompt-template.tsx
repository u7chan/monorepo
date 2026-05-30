import { useQuery } from '@tanstack/react-query'
import { hc } from 'hono/client'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { memo, useMemo, useState } from 'react'
import { useModelFetching } from '#/client/features/chat/components/chat-settings/hooks/use-model-fetching'
import { readFromLocalStorage, saveToLocalStorage } from '#/client/shared/storage/remote-storage-settings'
import type { AppType } from '#/server/app'

const client = hc<AppType>('/')

interface PromptTemplate {
  id: string
  inputType: 'text' | 'textarea'
  title: string
  placeholder: string
  prompt: string
}

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
  autoModel: boolean
  placeholder?: string
  onSubmit?: (templateInput: TemplateInput) => void
}

function PromptTemplateComponent({ autoModel, placeholder, onSubmit }: Props) {
  const [composing, setComposition] = useState(false)

  const promptTemplatesQuery = useQuery({
    queryKey: ['prompt-templates'],
    queryFn: async () => {
      const response = await client.api['prompt-templates'].$get()
      if (!response.ok) {
        return []
      }
      const { data } = await response.json()
      return data
    },
    staleTime: 5 * 60 * 1000,
  })
  const promptTemplates = promptTemplatesQuery.data ?? []

  const defaultSettings = useMemo(() => {
    return readFromLocalStorage()
  }, [])
  const [templateModels, setTemplateModels] = useState(defaultSettings.templateModels || {})
  const { fetchedModels, isLoadingModels, fetchError } = useModelFetching({ autoModel })

  const handleChangeComposition = (composition: boolean) => {
    setComposition(composition)
  }

  const handleChangeTemplateModel = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>, id: string) => {
    const nextTemplateModels = {
      ...templateModels,
      [id]: { model: event.target.value },
    }
    setTemplateModels(nextTemplateModels)
    saveToLocalStorage({
      templateModels: nextTemplateModels,
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
        model: templateModels[id]?.model || '',
        prompt,
        content,
      }
      onSubmit?.(templateInput)
    }
  }

  const renderTemplateModelInput = (template: PromptTemplate) => {
    const currentModel = templateModels[template.id]?.model || ''

    if (!autoModel) {
      return (
        <input
          type='text'
          spellCheck='false'
          className='rounded-sm border p-1 text-gray-600 text-xs transition-colors hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200'
          onChange={(event) => handleChangeTemplateModel(event, template.id)}
          value={currentModel}
          placeholder={placeholder}
        />
      )
    }

    return (
      <div className='relative'>
        <select
          className='w-40 appearance-none rounded-sm border p-1 pr-6 text-gray-600 text-xs transition-colors hover:border-primary-700 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-70 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200'
          onChange={(event) => handleChangeTemplateModel(event, template.id)}
          disabled={isLoadingModels || fetchedModels.length === 0}
          value={currentModel}
        >
          {isLoadingModels ? (
            <option>Loading...</option>
          ) : fetchError ? (
            <option>Error: {fetchError}</option>
          ) : fetchedModels.length === 0 ? (
            <option>No models available</option>
          ) : (
            <>
              <option value=''>Default Model</option>
              {fetchedModels.map((modelName) => (
                <option key={modelName} value={modelName}>
                  {modelName}
                </option>
              ))}
            </>
          )}
        </select>
        <svg
          viewBox='0 0 20 20'
          aria-hidden='true'
          className='pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 stroke-gray-600 dark:stroke-gray-300'
          fill='none'
        >
          <path d='M5 7.5L10 12.5L15 7.5' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
      </div>
    )
  }

  if (promptTemplates.length === 0) {
    return null
  }

  return (
    <div>
      <div className='grid grid-cols-1 gap-3 p-4 md:grid-cols-2'>
        {promptTemplates.map((template) => (
          <div
            key={template.id}
            className='rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-600 dark:bg-gray-800'
          >
            <div className='mb-2 flex items-center justify-between'>
              <div className='line-clamp-2 font-semibold text-gray-700 text-sm dark:text-gray-200'>
                {template.title}
              </div>
              <div className='flex items-center gap-2'>
                <div className='text-gray-500 text-xs dark:text-gray-400'>Model</div>
                {renderTemplateModelInput(template)}
              </div>
            </div>
            <p className='text-gray-600 dark:text-gray-200'>
              {template.inputType === 'text' ? (
                <input
                  type='text'
                  spellCheck='false'
                  className='w-full rounded-sm border p-1 text-sm transition-colors placeholder-gray-400 hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-400'
                  placeholder={template.placeholder}
                  onKeyDown={(e) => handleKeyDownTemplate(e, template)}
                  onCompositionStart={() => handleChangeComposition(true)}
                  onCompositionEnd={() => handleChangeComposition(false)}
                />
              ) : (
                <textarea
                  className='max-h-64 min-h-8 w-full rounded-sm border p-1 text-sm transition-colors placeholder-gray-400 hover:border-primary-700 focus:outline-hidden dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-400'
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

export const PromptTemplate = memo(PromptTemplateComponent)
