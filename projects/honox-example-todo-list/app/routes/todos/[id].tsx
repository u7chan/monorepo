import { createRoute } from 'honox/factory'
import { css } from 'hono/css'

export default createRoute(async (c) => {
  const { id } = c.req.param<'/:id'>()
  const todos = (await Bun.file('app/data/todo.json').json()) as {
    id: string
    title: string
    content: string
    done: boolean
  }[]

  const todo = todos.find((x) => x.id === id)
  if (!todo) {
    // Not found items
    return c.redirect('/todos')
  }

  return c.render(
    <div>
      <a href="/todos">Back</a>
      <h1>{todo.title}</h1>
      <div
        class={css`
          width: 90%;
          height: 100px;
        `}
      >
        {todo.content}
      </div>
    </div>
  )
})
