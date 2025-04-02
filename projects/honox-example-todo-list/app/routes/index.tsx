import { createRoute } from 'honox/factory'

export default createRoute((c) => {
  return c.render(
    <div>
      <h1>Index</h1>
      <nav>
        <ul>
          <li>
            <a href="/about">about</a>
          </li>
          <li>
            <a href="/todos">todos</a>
          </li>
        </ul>
      </nav>
    </div>
  )
})
