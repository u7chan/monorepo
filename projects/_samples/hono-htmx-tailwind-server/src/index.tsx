import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.html(
    <>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>htmx + Tailwind CSS + Loading サンプル</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/htmx.org@1.9.12"></script>
        <style>{`
          .htmx-indicator {
            opacity: 0;
            transition: opacity 200ms ease-in-out;
            pointer-events: none;
          }
          .htmx-request .htmx-indicator {
            opacity: 1;
          }
          .htmx-request #result {
            opacity: 0.5;
          }
        `}</style>
      </head>
      <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen p-8">
        <div class="max-w-2xl mx-auto">
          <h1 class="text-4xl font-bold text-gray-900 mb-8 text-center bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            htmx + Tailwind CSS + Loading サンプル
          </h1>
          <button
            class="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transform hover:scale-105 transition-all duration-200 mb-8 disabled:opacity-50 disabled:cursor-not-allowed"
            hx-get="https://httpbin.org/json"
            hx-trigger="click"
            hx-target="#result"
            hx-swap="innerHTML"
            hx-indicator="#spinner"
          >
            🚀 JSONデータを取得
          </button>
          <div class="relative">
            <div
              id="spinner"
              class="htmx-indicator absolute inset-0 flex justify-center items-center bg-white/80 backdrop-blur-sm rounded-xl shadow-xl z-10"
            >
              <div class="flex flex-col items-center space-y-2">
                <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                <p class="text-sm font-medium text-gray-700">読み込み中...</p>
              </div>
            </div>
            <div
              id="result"
              class="bg-white p-8 rounded-xl shadow-xl border-2 border-dashed border-gray-300 min-h-[150px] transition-all duration-300 relative z-0"
            >
              <p class="text-gray-500 italic text-center py-12">
                ここに結果が表示されます... ボタンをクリックしてみて！ (ローディングが表示されます)
              </p>
            </div>
          </div>
        </div>
      </body>
    </>
  )
})

export default app
