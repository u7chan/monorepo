import { createRoute } from 'honox/factory'
import { css } from 'hono/css'

export default createRoute(async (c) => {
  const { todos } = (await Bun.file('app/data/todo.json').json()) as {
    todos: {
      id: string
      title: string
      content: string
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
          </li>
        ))}
      </ul>
    </div>
  )
})
