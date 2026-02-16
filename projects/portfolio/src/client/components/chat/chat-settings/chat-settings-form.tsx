import { ToggleInput } from '#/client/components/input/toggle-input'
import type { Settings } from '#/client/storage/remote-storage-settings'
import { type ChangeEvent } from 'react'
import { ModelSelector } from './model-selector'
import { AutoModelToggle } from './settings/auto-model-toggle'
import { ReasoningEffort } from './settings/reasoning-effort'
import { TemperatureSlider } from './settings/temperature-slider'
import { TextInput } from './settings/text-input'

interface Props {
  settings: Settings
  fetchedModels: string[]
  temperature: number
  temperatureEnabled: boolean
  autoModel: boolean
  fakeMode: boolean
  markdownPreview: boolean
  streamMode: boolean
  interactiveMode: boolean
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  reasoningEffortEnabled: boolean
  onChangeAutoModel: (event: ChangeEvent<HTMLSelectElement>) => void
  onChangeManualModel: (event: ChangeEvent<HTMLInputElement>) => void
  onChangeBaseURL: (event: ChangeEvent<HTMLInputElement>) => void
  onChangeApiKey: (event: ChangeEvent<HTMLInputElement>) => void
  onChangeMcpServerURLs: (event: ChangeEvent<HTMLInputElement>) => void
  onChangeTemperature: (event: ChangeEvent<HTMLInputElement>) => void
  onChangeMaxTokens: (event: ChangeEvent<HTMLInputElement>) => void
  onToggleTemperature: () => void
  onToggleAutoModel: () => void
  onToggleFakeMode: () => void
  onToggleMarkdownPreview: () => void
  onToggleStreamMode: () => void
  onToggleInteractiveMode: () => void
  onToggleReasoningEffort: () => void
  onChangeReasoningEffort: (event: ChangeEvent<HTMLSelectElement>) => void
}

export function ChatSettingsForm({
  settings,
  fetchedModels,
  temperature,
  temperatureEnabled,
  autoModel,
  fakeMode,
  markdownPreview,
  streamMode,
  interactiveMode,
  reasoningEffort,
  reasoningEffortEnabled,
  onChangeAutoModel,
  onChangeManualModel,
  onChangeBaseURL,
  onChangeApiKey,
  onChangeMcpServerURLs,
  onChangeTemperature,
  onChangeMaxTokens,
  onToggleTemperature,
  onToggleAutoModel,
  onToggleFakeMode,
  onToggleMarkdownPreview,
  onToggleStreamMode,
  onToggleInteractiveMode,
  onToggleReasoningEffort,
  onChangeReasoningEffort,
}: Props) {
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
            <ModelSelector
              model={settings.model}
              autoModel={autoModel}
              fakeMode={fakeMode}
              fetchedModels={fetchedModels}
              onChangeAutoModel={onChangeAutoModel}
              onChangeManualModel={onChangeManualModel}
            />
          </div>

          {/* Auto Model Toggle */}
          <AutoModelToggle autoModel={autoModel} onClick={onToggleAutoModel} />
        </div>
      </section>

      {/* API Configuration */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>API Configuration</h3>
        <div className='space-y-3'>
          <TextInput
            name='baseURL'
            label='Base URL'
            defaultValue={settings.baseURL || 'https://api.openai.com/v1'}
            placeholder='https://api.openai.com/v1'
            disabled={fakeMode}
            onChange={onChangeBaseURL}
          />

          <TextInput
            name='apiKey'
            label='API Key'
            type='password'
            defaultValue={settings.apiKey}
            placeholder='Enter your API key'
            disabled={fakeMode}
            onChange={onChangeApiKey}
          />

          <TextInput
            name='mcpServerURLs'
            label='MCP Server URLs'
            suffix='(comma separated)'
            defaultValue={settings.mcpServerURLs || ''}
            placeholder='http://localhost:3001, http://localhost:3002'
            disabled={fakeMode}
            onChange={onChangeMcpServerURLs}
          />
        </div>
      </section>

      {/* Parameters */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Parameters</h3>
        <div className='space-y-4'>
          <TemperatureSlider
            temperature={temperature}
            temperatureEnabled={temperatureEnabled}
            onChange={onChangeTemperature}
            onToggle={onToggleTemperature}
          />

          <TextInput
            name='maxTokens'
            label='Max Tokens'
            type='number'
            min={1}
            max={4096}
            defaultValue={settings.maxTokens?.toString()}
            placeholder='Max tokens'
            onChange={onChangeMaxTokens}
          />

          <ReasoningEffort
            reasoningEffort={reasoningEffort}
            reasoningEffortEnabled={reasoningEffortEnabled}
            onChange={onChangeReasoningEffort}
            onToggle={onToggleReasoningEffort}
          />
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
            onClick={onToggleMarkdownPreview}
          />
          <ToggleInput
            label='Stream Mode'
            labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
            value={streamMode}
            onClick={onToggleStreamMode}
          />
          <ToggleInput
            label='Interactive Mode'
            labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
            value={interactiveMode}
            onClick={onToggleInteractiveMode}
          />
        </div>
      </section>

      {/* Debug Options */}
      <section className='space-y-3'>
        <h3 className='text-sm font-medium text-gray-500 uppercase dark:text-gray-400'>Debug Options</h3>
        <ToggleInput
          label='Fake Mode'
          labelClassName='text-sm font-medium text-gray-700 dark:text-gray-300'
          value={fakeMode}
          onClick={onToggleFakeMode}
        />
      </section>

      {/* Bottom spacing for safe area */}
      <div className='h-6' />
    </div>
  )
}
