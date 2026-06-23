import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

export function App() {
  const [count, setCount] = useState(0)

  return (
    <main>
      <h1>Browser Auto</h1>
      <p>Count: {count}</p>
      <button type="button" onClick={() => setCount((current) => current + 1)}>
        Increment
      </button>
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
