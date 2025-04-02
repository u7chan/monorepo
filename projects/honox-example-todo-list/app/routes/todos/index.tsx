import { createRoute } from 'honox/factory'

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
          <li key={todo.title} style="display:flex;gap:2px;">
            <input type="checkbox" checked={todo.done} />
            <div>{todo.title}</div>
          </li>
        ))}
      </ul>
    </div>
  )
})
