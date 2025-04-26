import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.html(Bun.file('src/index.html').text()))

export default app
