import { Hono } from 'hono'
import { renderToString } from 'react-dom/server'
import type { HonoEnv } from './shared'
import { getServerEnv, getSignedInEmail } from './shared'

const htmlRoutes = new Hono<HonoEnv>().get('*', async (c) => {
  const { NODE_ENV } = getServerEnv(c)
  const prod = NODE_ENV === 'production'
  const email = await getSignedInEmail(c)

  return c.html(
    renderToString(
      <html lang='ja'>
        <head>
          <meta charSet='utf-8' />
          <meta name='viewport' content='width=device-width, initial-scale=1' />
          <meta name='props' content={`${JSON.stringify({ email })}`} />
          <title>Portfolio</title>
          <link rel='icon' href={prod ? '/static/favicon.ico' : 'favicon.ico'} />
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark');})();`,
            }}
          />
          <link rel='stylesheet' href={prod ? '/static/main.css' : '/src/client/main.css'} />
          <script type='module' src={prod ? '/static/client.js' : '/src/client/main.tsx'} />
        </head>
        <body>
          <div id='root' />
        </body>
      </html>
    )
  )
})

export { htmlRoutes }
