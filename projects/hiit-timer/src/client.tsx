import { render } from 'hono/jsx/dom'

function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold underline">Hello world!</h1>
      <div className="mt-6">
        <button
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 hover:shadow-md transform hover:scale-105 transition ease-in-out duration-150"
          hx-get="/time"
          hx-target="#result"
          hx-swap="innerHTML"
        >
          現在時刻を取得
        </button>
      </div>
      <div id="result" className="mt-4 text-lg">
        現在時刻: {new Date().toLocaleTimeString()}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
render(<App />, root!)
