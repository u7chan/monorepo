import { createRoute } from 'honox/factory'
import { css } from 'hono/css'

export const POST = createRoute(async (c) => {
  const { id, title } = await c.req.parseBody<{ id?: string; title?: string }>()

  const todos = (await Bun.file('app/data/todo.json').json()) as {
    id: string
    title: string
    content: string
    done: boolean
  }[]

  if (title) {
    // create
    const newTodo = {
      id: Bun.randomUUIDv7(),
      title,
      content: '',
      done: false,
    }
    const newTodos = [...todos, newTodo]
    await Bun.write('app/data/todo.json', JSON.stringify(newTodos, null, 2))
  }
  if (id) {
    // delete
    const newTodos = todos.filter((x) => x.id !== id)
    await Bun.write('app/data/todo.json', JSON.stringify(newTodos, null, 2))
  }
  return c.redirect('/todos')
})

export default createRoute(async (c) => {
  const todos = (await Bun.file('app/data/todo.json').json()) as {
    id: string
    title: string
    content: string
    done: boolean
  }[]
  return c.render(
    <div>
      <h1>ToDo List</h1>
      <form
        method="post"
        class={css`
          margin-left: 40px;
          display: flex;
          gap: 8px;
        `}
      >
        <input type="text" name="title" placeholder="todo" required />
        <input type="submit" value="Add" />
      </form>
      <ul>
        {todos.map((todo) => (
          <li
            key={todo.title}
            class={css`
              display: flex;
              gap: 8px;
              padding: 8px;
              & > *:nth-child(2) {
                flex-grow: 1;
              }
            `}
          >
            <input type="checkbox" id={todo.id} checked={todo.done} />
            <label for={todo.id}>{todo.title}</label>
            <a href={`/todos/${todo.id}`}>Detail</a>
            <form method="post">
              <input name="id" value={todo.id} hidden />
              <button
                type="submit"
                class={css`
                  background: red;
                  color: white;
                  border: none;
                  padding: 4px;
                  cursor: pointer;
                `}
              >
                Delete
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
})
