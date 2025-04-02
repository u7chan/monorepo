import { Hono } from 'hono'

const app = new Hono()

app.get('/about', (c) => {
  return c.render(
    <div>
      <h1>About</h1>
    </div>
  )
})

export default app
