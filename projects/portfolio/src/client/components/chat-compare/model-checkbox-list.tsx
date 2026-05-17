import { useCallback } from 'react'
import { SpinnerIcon } from '#/client/components/svg/spinner-icon'

interface ModelCheckboxListProps {
  models: string[]
  selectedModels: string[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (selected: string[]) => void
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
    <div className='flex flex-wrap gap-2 px-2'>
      {models.map((model) => (
        <label
          key={model}
          className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${
            selectedModels.includes(model)
              ? 'border-primary-300 bg-primary-50 text-primary-800 dark:border-primary-600 dark:bg-primary-900/30 dark:text-primary-300'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          <input
            type='checkbox'
            checked={selectedModels.includes(model)}
            onChange={() => handleToggle(model)}
            disabled={disabled}
            className='h-3.5 w-3.5 rounded border-gray-300 text-primary-700 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:focus:ring-primary-400'
          />
          <span className='truncate max-w-[200px]'>{model}</span>
        </label>
      ))}
    </div>
  )
}
