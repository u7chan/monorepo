import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

export function App() {
  const [count, setCount] = useState(0)

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">Browser Auto</h1>
      <p className="mt-4">Count: {count}</p>
      <button
        type="button"
        className="mt-2 cursor-pointer rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        onClick={() => setCount((current) => current + 1)}
      >
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
