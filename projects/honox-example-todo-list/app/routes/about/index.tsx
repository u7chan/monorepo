import { createRoute } from 'honox/factory'

export default createRoute(async (c) => {
  return c.render(
    <div>
      <h1>About</h1>
    </div>
  )
})
