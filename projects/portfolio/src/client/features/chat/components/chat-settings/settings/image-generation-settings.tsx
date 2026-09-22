import { useChatSettingsContext } from '../chat-settings-context'
import { SectionHeading } from './section-heading'
import { TextInput } from './text-input'

const selectEnabledClassName =
  'border-gray-300 bg-white text-gray-900 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
const selectDisabledClassName =
  'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500'

export function ImageGenerationSettings() {
  const {
    settings,
    imageModels,
    isLoadingImageModels,
    imageModelsError,
    refetchImageModels,
    resolvedImageGenerationModel,
    handleChangeImageGenerationModel,
    handleChangeImageGenerationBaseURL,
    handleChangeImageGenerationApiKey,
  } = useChatSettingsContext()

  const hasModels = imageModels.length > 0
  const isSelectDisabled = isLoadingImageModels || !hasModels

  return (
    <section className='space-y-3'>
      <SectionHeading>Image Generation</SectionHeading>
      <div className='space-y-3'>
        <div className='space-y-2'>
          <label
            htmlFor='image-generation-model'
            className='block text-sm font-medium text-gray-700 dark:text-gray-300'
          >
            Image Model
          </label>
          <div className='relative'>
            <select
              id='image-generation-model'
              name='imageGenerationModel'
              value={resolvedImageGenerationModel ?? ''}
              onChange={handleChangeImageGenerationModel}
              disabled={isSelectDisabled}
              className={`w-full appearance-none rounded-md border px-3 py-2 pr-9 text-sm outline-none transition-all duration-200 ${
                isSelectDisabled ? selectDisabledClassName : selectEnabledClassName
              }`}
            >
              {isLoadingImageModels ? (
                <option value=''>Loading...</option>
              ) : hasModels ? (
                imageModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))
              ) : (
                <option value=''>{imageModelsError ?? 'No models available'}</option>
              )}
            </select>
            <svg
              viewBox='0 0 20 20'
              aria-hidden='true'
              className={`pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 ${
                hasModels && !isLoadingImageModels ? 'stroke-gray-600 dark:stroke-gray-300' : 'stroke-gray-400'
              }`}
              fill='none'
            >
              <path d='M5 7.5L10 12.5L15 7.5' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </div>
          {!isLoadingImageModels && !hasModels && (
            <div className='space-y-1'>
              <p className='text-xs text-red-600 dark:text-red-400'>
                画像生成モデルを取得できませんでした。Base URL と API Key を確認してください。
              </p>
              <button
                type='button'
                onClick={refetchImageModels}
                className='text-xs font-medium text-blue-600 hover:underline dark:text-blue-400'
              >
                再読み込み
              </button>
            </div>
          )}
          <p className='text-xs text-gray-500 dark:text-gray-400'>
            接続先の /models から画像生成モデルだけを表示します。未選択のときは優先順（gpt-image-2.5-flare →
            gpt-image-2.5-sunburst → gpt-image-2）で選びます。
          </p>
        </div>

        <TextInput
          name='imageGenerationBaseURL'
          label='Image Base URL'
          defaultValue={settings.imageGenerationBaseURL}
          placeholder='未設定の場合は API Configuration の Base URL を使用します'
          onChange={handleChangeImageGenerationBaseURL}
        />

        <TextInput
          name='imageGenerationApiKey'
          label='Image API Key'
          type='password'
          defaultValue={settings.imageGenerationApiKey}
          placeholder='未設定の場合は API Configuration の API Key を使用します'
          autoComplete='new-password'
          autoCapitalize='none'
          autoCorrect='off'
          spellCheck={false}
          onChange={handleChangeImageGenerationApiKey}
        />

        <p className='text-xs text-gray-500 dark:text-gray-400'>
          画像モデルだけを許可した API キーを使う場合に設定します。空の場合は API Configuration の値を共用します。
        </p>
      </div>
    </section>
  )
}
