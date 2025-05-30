import { createRoot } from 'react-dom/client'
import { App } from '#/client/App'

// 初期テーマ設定
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme') || 'system'
  const root = document.documentElement

  root.classList.remove('light', 'dark')

  if (savedTheme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    root.classList.add(systemTheme)
  } else {
    root.classList.add(savedTheme)
  }
}

// テーマを初期化
initializeTheme()

const elem = document.querySelector('#root')
if (elem) {
  const root = createRoot(elem)
  root.render(<App />)
}
