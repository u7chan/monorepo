import { useCallback, useMemo } from 'react'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'

interface ModelCheckboxListProps {
  models: string[]
  selectedModels: string[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (selected: string[]) => void
}

interface GroupedModel {
  id: string
  label: string
}

interface ModelGroup {
  provider: string
  models: GroupedModel[]
}

const OTHER_PROVIDER = 'その他'

export function groupModelsByProvider(models: string[]): ModelGroup[] {
  const groups = new Map<string, GroupedModel[]>()

  for (const model of models) {
    const separatorIndex = model.indexOf('/')
    const hasProviderAndModel = separatorIndex > 0 && separatorIndex < model.length - 1
    const provider = hasProviderAndModel ? model.slice(0, separatorIndex) : OTHER_PROVIDER
    const label = hasProviderAndModel ? model.slice(separatorIndex + 1) : model
    const groupModels = groups.get(provider) ?? []

    groupModels.push({ id: model, label })
    groups.set(provider, groupModels)
  }

  return Array.from(groups, ([provider, groupedModels]) => ({ provider, models: groupedModels }))
}

export function ModelCheckboxList({
  models,
  selectedModels,
  loading,
  error,
  disabled,
  onChange,
}: ModelCheckboxListProps) {
  const handleToggle = useCallback(
    (model: string) => {
      const next = selectedModels.includes(model)
        ? selectedModels.filter((m) => m !== model)
        : [...selectedModels, model]
      onChange(next)
    },
    [onChange, selectedModels]
  )
  const modelGroups = useMemo(() => groupModelsByProvider(models), [models])

  if (loading) {
    return (
      <div className='flex items-center justify-center gap-2 py-4'>
        <SpinnerIcon />
        <span className='text-sm text-gray-500 dark:text-gray-400'>モデル一覧を取得中...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className='py-2 text-center text-red-500 text-sm dark:text-red-400'>
        {error}
        <p className='mt-1 text-xs text-gray-400'>設定を確認してください</p>
      </div>
    )
  }

  if (models.length === 0) {
    return (
      <div className='py-2 text-center text-gray-400 text-sm dark:text-gray-500'>
        モデルが見つかりません。設定でBase URLとAPI Keyを構成してください
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-3 px-2'>
      {modelGroups.map((group) => (
        <section key={group.provider} className='grid gap-1.5'>
          <div className='flex items-center gap-2'>
            <h2 className='font-semibold text-gray-600 text-xs dark:text-gray-300'>{group.provider}</h2>
            <span className='text-gray-400 text-xs dark:text-gray-500'>{group.models.length}</span>
          </div>
          <div className='flex flex-wrap gap-2'>
            {group.models.map((model) => (
              <label
                key={model.id}
                title={model.id}
                className={`flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors ${
                  selectedModels.includes(model.id)
                    ? 'border-primary-300 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
                } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <input
                  type='checkbox'
                  checked={selectedModels.includes(model.id)}
                  onChange={() => handleToggle(model.id)}
                  disabled={disabled}
                  className='h-3.5 w-3.5 rounded border-gray-300 text-primary-700 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:focus:ring-primary-400'
                />
                <span className='max-w-[220px] truncate'>{model.label}</span>
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
