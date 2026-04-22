import { ToggleInput } from '#/client/components/input/toggle-input'
import { useChatSettingsContext } from './chat-settings-context'
import { ModelSelector } from './model-selector'
import { AutoModelToggle } from './settings/auto-model-toggle'
import { ReasoningEffort } from './settings/reasoning-effort'
import { TemperatureSlider } from './settings/temperature-slider'
import { TextInput } from './settings/text-input'

export function ChatSettingsForm() {
  const {
    settings,
    apiMode,
    fakeMode,
    markdownPreview,
    streamMode,
    interactiveMode,
    handleChangeBaseURL,
    handleChangeApiKey,
    handleChangeApiMode,
    handleChangeMaxTokens,
    handleToggleFakeMode,
    handleToggleMarkdownPreview,
    handleToggleStreamMode,
    handleToggleInteractiveMode,
  } = useChatSettingsContext()

  return (
    <div className='flex flex-col gap-5'>
      {/* Model Section */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Model</h3>
        <div className='space-y-3'>
          {/* Model Selection */}
          <div className='space-y-2'>
            <label
              className={`block text-sm font-medium ${fakeMode ? 'text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}
            >
              Model
            </label>
            <ModelSelector />
          </div>

          {/* Auto Model Toggle */}
          <AutoModelToggle />
        </div>
      </section>

      {/* API Configuration */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>API Configuration</h3>
        <div className='space-y-3'>
          <div className='space-y-2'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>API Mode</label>
            <div className='relative'>
              <select
                value={apiMode}
                onChange={handleChangeApiMode}
                className='w-full appearance-none rounded-md border border-gray-300 bg-white px-3 py-2 pr-9 text-sm text-gray-900 outline-none transition-all duration-200 hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:ring-blue-800'
              >
                <option value='chat_completions'>Chat Completions</option>
                <option value='responses'>Responses</option>
              </select>
              <svg
                viewBox='0 0 20 20'
                aria-hidden='true'
                className='pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 stroke-gray-600 dark:stroke-gray-300'
                fill='none'
              >
                <path d='M5 7.5L10 12.5L15 7.5' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' />
              </svg>
            </div>
            {apiMode === 'responses' && (
              <p className='text-xs text-gray-500 dark:text-gray-400'>Responses では Fake Mode を利用できません。</p>
            )}
          </div>

          <TextInput
            name='baseURL'
            label='Base URL'
            defaultValue={settings.baseURL || 'https://api.openai.com/v1'}
            placeholder='https://api.openai.com/v1'
            disabled={fakeMode}
            onChange={handleChangeBaseURL}
          />

          <div className='space-y-2'>
            <TextInput
              name='apiKey'
              label='API Key'
              type='password'
              defaultValue={settings.apiKey}
              placeholder='Enter your API key'
              disabled={fakeMode}
              autoComplete='new-password'
              autoCapitalize='none'
              autoCorrect='off'
              spellCheck={false}
              onChange={handleChangeApiKey}
            />
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              API Key はブラウザの localStorage に保存されます。秘匿ストアではありません。
            </p>
          </div>
        </div>
      </section>

      {/* Parameters */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Parameters</h3>
        <div className='space-y-4'>
          <TemperatureSlider />

          <TextInput
            name='maxTokens'
            label='Max Tokens'
            type='number'
            min={1}
            max={4096}
            defaultValue={settings.maxTokens?.toString()}
            placeholder='Max tokens'
            onChange={handleChangeMaxTokens}
          />

          <ReasoningEffort />
        </div>
      </section>

      {/* Display Options */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Display Options</h3>
        <div className='space-y-3'>
          <ToggleInput
            label='Markdown Preview'
            labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
            value={markdownPreview}
            onClick={handleToggleMarkdownPreview}
          />
          <ToggleInput
            label='Stream Mode'
            labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
            value={streamMode}
            onClick={handleToggleStreamMode}
          />
          <ToggleInput
            label='Interactive Mode'
            labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
            value={interactiveMode}
            onClick={handleToggleInteractiveMode}
          />
        </div>
      </section>

      {/* Debug Options */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Debug Options</h3>
        <div className='space-y-2'>
          <ToggleInput
            label='Fake Mode'
            labelClassName={`text-sm font-medium ${apiMode === 'responses' ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}
            value={fakeMode}
            disabled={apiMode === 'responses'}
            onClick={handleToggleFakeMode}
          />
          {apiMode === 'responses' && (
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              Fake Mode は `chat_completions` のみサポートします。
            </p>
          )}
        </div>
      </section>

      {/* Bottom spacing for safe area */}
      <div className='h-6' />
    </div>
  )
}
