import { jsxRenderer } from 'hono/jsx-renderer'
import { Style } from 'hono/css'

export default jsxRenderer(({ children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Honox Example</title>
        <Style />
      </head>
      <body>{children}</body>
    </html>
  )
})
