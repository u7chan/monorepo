import { GearIcon } from '#/client/components/svg/gear-icon'
import { NewChatIcon } from '#/client/components/svg/new-chat-icon'
import { SidebarIcon } from '#/client/components/svg/sidebar-icon'
import type { Settings } from '#/client/storage/remote-storage-settings'
import { ChatSettingsProvider } from './chat-settings-context'
import { ChatSettingsForm } from './chat-settings-form'
import { ChatSettingsPanel } from './chat-settings-panel'
import { useChatSettings } from './hooks/use-chat-settings'

interface Props {
  showActions?: boolean
  showNewChat?: boolean
  showPopup?: boolean
  showSidebarToggle?: boolean
  isSidebarOpen?: boolean
  isSidebarToggleDisabled?: boolean
  onNewChat?: () => void
  onShowMenu?: () => void
  onToggleSidebar?: () => void
  onChange?: (settings: Settings) => void
  onHidePopup?: () => void
}

export function ChatSettings({
  showActions,
  showNewChat = true,
  showPopup,
  showSidebarToggle = true,
  isSidebarOpen = true,
  isSidebarToggleDisabled = false,
  onNewChat,
  onShowMenu,
  onToggleSidebar,
  onChange,
  onHidePopup,
}: Props) {
  const contextValue = useChatSettings({ showPopup, onChange })

  return (
    <>
      {/* Header Bar */}
      <div className='flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 dark:border-gray-700'>
        {showActions && (
          <>
            {/* Left side */}
            <div className='flex items-center gap-2'>
              {showSidebarToggle && (
                <button
                  type='button'
                  onClick={onToggleSidebar}
                  disabled={isSidebarToggleDisabled}
                  className='flex items-center justify-center rounded-md p-2 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
                >
                  <SidebarIcon
                    variant={isSidebarOpen ? 'collapse' : 'expand'}
                    className='fill-[#5D5D5D] dark:fill-gray-300'
                  />
                </button>
              )}
              {showNewChat && (
                <button
                  type='button'
                  onClick={onNewChat}
                  className='flex cursor-pointer items-center justify-center rounded-md p-2 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
                >
                  <NewChatIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
                </button>
              )}
            </div>
            {/* Right side */}
            <div className='flex items-center gap-2'>
              <span className='max-w-48 truncate text-xs font-medium text-gray-500 dark:text-gray-400'>
                {contextValue.fakeMode ? 'Fake Mode' : contextValue.settings.model}
              </span>
              <button
                type='button'
                onClick={onShowMenu}
                className='flex cursor-pointer items-center justify-center rounded-md p-2 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:text-gray-300 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
              >
                <GearIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Settings Panel */}
      <ChatSettingsProvider value={contextValue}>
        <ChatSettingsPanel show={showPopup ?? false} onClose={onHidePopup ?? (() => {})}>
          <ChatSettingsForm />
        </ChatSettingsPanel>
      </ChatSettingsProvider>
    </>
  )
}
