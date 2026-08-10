import { IconButton } from '#/client/shared/components/icon-button/icon-button'
import { GearIcon } from '#/client/shared/icons/gear-icon'
import { NewChatIcon } from '#/client/shared/icons/new-chat-icon'
import { SidebarIcon } from '#/client/shared/icons/sidebar-icon'
import type { Settings } from '#/client/shared/storage/remote-storage-settings'
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
  imageGenerationMode?: boolean
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
  imageGenerationMode = false,
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
                <IconButton
                  label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                  onClick={onToggleSidebar}
                  disabled={isSidebarToggleDisabled}
                  aria-expanded={isSidebarOpen}
                  className='rounded-md p-2 text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                >
                  <SidebarIcon
                    variant={isSidebarOpen ? 'collapse' : 'expand'}
                    className='text-[#5D5D5D] dark:text-gray-300'
                  />
                </IconButton>
              )}
              {showNewChat && (
                <IconButton
                  label='New chat'
                  onClick={onNewChat}
                  className='rounded-md p-2 text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                >
                  <NewChatIcon className='text-[#5D5D5D] dark:text-gray-300' />
                </IconButton>
              )}
            </div>
            {/* Right side */}
            <div className='flex items-center gap-2'>
              <span className='max-w-48 truncate text-xs font-medium text-gray-500 dark:text-gray-400'>
                {imageGenerationMode
                  ? 'gpt-image-2'
                  : contextValue.fakeMode
                    ? 'Fake Mode'
                    : contextValue.settings.model}
              </span>
              {!imageGenerationMode && (
                <IconButton
                  label='Settings'
                  onClick={onShowMenu}
                  className='rounded-md p-2 text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                >
                  <GearIcon className='text-[#5D5D5D] dark:text-gray-300' />
                </IconButton>
              )}
            </div>
          </>
        )}
      </div>

      {/* Settings Panel */}
      <ChatSettingsProvider value={contextValue}>
        <ChatSettingsPanel show={!imageGenerationMode && (showPopup ?? false)} onClose={onHidePopup ?? (() => {})}>
          <ChatSettingsForm />
        </ChatSettingsPanel>
      </ChatSettingsProvider>
    </>
  )
}
