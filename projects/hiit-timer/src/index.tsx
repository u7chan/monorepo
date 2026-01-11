import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.html(<>Hello</>)
})

export default app
