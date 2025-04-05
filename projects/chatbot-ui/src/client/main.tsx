import { App } from '@/client/App'
import { createRoot } from 'react-dom/client'

const elem = document.querySelector('#root')
if (elem) {
  const root = createRoot(elem)
  root.render(<App />)
}
