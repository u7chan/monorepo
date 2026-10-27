import type { ReactNode } from 'react'
import { AboutIcon } from '#/client/shared/icons/about-icon'
import { ChatbotIcon } from '#/client/shared/icons/chatbot-icon'
import { CompareIcon } from '#/client/shared/icons/compare-icon'
import { DashboardIcon } from '#/client/shared/icons/dashboard-icon'
import { DiffIcon } from '#/client/shared/icons/diff-icon'
import { SparkleIcon } from '#/client/shared/icons/sparkle-icon'

export type MenuItem = {
  label: string
  icon: ReactNode
  to: string
}

/**
 * チャット系の画面は API がログイン必須なので、未ログイン時はメニューにも出さない。
 * URL 直打ちは各ルートの beforeLoad で弾く。
 */
export function buildMenuItems({ isSignedIn }: { isSignedIn: boolean }): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Home', icon: <DashboardIcon size={24} />, to: '/' },
    { label: 'About', icon: <AboutIcon size={18} />, to: '/about' },
    { label: 'Diff', icon: <DiffIcon size={20} />, to: '/diff' },
  ]

  if (isSignedIn) {
    items.push(
      { label: 'Chat', icon: <ChatbotIcon size={26} />, to: '/chat' },
      { label: 'Compare', icon: <CompareIcon size={22} />, to: '/chat-compare' }
    )
  }

  if (import.meta.env.DEV) {
    items.push({ label: 'SVGs', icon: <SparkleIcon size={20} />, to: '/debug/svg-catalog' })
  }

  return items
}
