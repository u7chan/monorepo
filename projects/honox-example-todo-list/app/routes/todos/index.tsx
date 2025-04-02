import { createRoute } from 'honox/factory'
import { css } from 'hono/css'

export default createRoute(async (c) => {
  const { todos } = (await Bun.file('app/data/todo.json').json()) as {
    todos: {
      id: string
      title: string
      done: boolean
    }[]
  }
  return c.render(
    <div>
      <h1>ToDo List</h1>
      <ul>
        {todos.map((todo) => (
          <li
            key={todo.title}
            class={css`
              display: flex;
              gap: 2px;
            `}
          >
            <input type="checkbox" id={todo.id} checked={todo.done} />
            <label for={todo.id}>{todo.title}</label>
          </li>
        ))}
      </ul>
    </div>
  )
})
