import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

export function App() {
  return (
    <main>
      <h1>Browser Auto</h1>
      <p>Client foundation is ready.</p>
    </main>
  )
}

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
