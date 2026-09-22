export type SettingsTab = 'chat' | 'image'

const tabs: { value: SettingsTab; label: string }[] = [
  { value: 'chat', label: 'チャット' },
  { value: 'image', label: '画像生成' },
]

export function SettingsTabs({
  activeTab,
  onChange,
}: {
  activeTab: SettingsTab
  onChange: (tab: SettingsTab) => void
}) {
  return (
    <div role='tablist' aria-label='設定の種類' className='flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-700'>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          id={`settings-tab-${tab.value}`}
          type='button'
          role='tab'
          aria-selected={activeTab === tab.value}
          aria-controls={`settings-tabpanel-${tab.value}`}
          onClick={() => onChange(tab.value)}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeTab === tab.value
              ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
