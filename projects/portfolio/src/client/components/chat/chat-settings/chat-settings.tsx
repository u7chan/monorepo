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
  onNewChat,
  onShowMenu,
  onToggleSidebar,
  onChange,
  onHidePopup,
}: Props) {
  const contextValue = useChatSettings({ showPopup, onChange })

  return (
    <>
      {/* Button Group - Fixed position (top-left, accounting for sidebar on desktop) */}
      <div className='fixed top-0 left-0 z-30 p-4 md:left-16'>
        {showActions && (
          <div className='flex flex-col items-center gap-2 sm:flex-row'>
            {/* Sidebar Toggle - Mobile only (shown only when logged in) */}
            {showSidebarToggle && (
              <button
                type='button'
                onClick={onToggleSidebar}
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 md:hidden dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
              >
                <SidebarIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            {showNewChat && (
              <button
                type='button'
                onClick={onNewChat}
                className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
              >
                <NewChatIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
              </button>
            )}
            <button
              type='button'
              onClick={onShowMenu}
              className='flex transform cursor-pointer items-center justify-center rounded-full bg-white p-2 transition duration-300 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700 dark:focus:ring-gray-500'
            >
              <GearIcon className='fill-[#5D5D5D] dark:fill-gray-300' />
            </button>
            <span className='hidden max-w-48 truncate text-xs font-medium text-gray-900 sm:block dark:text-gray-200'>
              {contextValue.fakeMode ? 'Fake Mode' : contextValue.settings.model}
            </span>
          </div>
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
