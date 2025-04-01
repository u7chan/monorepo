import { Hono } from 'hono'

const app = new Hono()

app.get('/:name', (c) => {
  const name = c.req.param('name')
  return c.render(
    <div>
      <h1>About</h1>
      <hr />
      <p>{name}</p>
    </div>
  )
})

export default app
