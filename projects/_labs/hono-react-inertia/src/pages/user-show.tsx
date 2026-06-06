export type UserShowProps = {
  user: {
    id: string
    name: string
    role: string
  }
  notifications: string[]
}

export default function UserShow({ user, notifications }: UserShowProps) {
  return (
    <main>
      <h1>{user.name}</h1>
      <dl>
        <dt>ID</dt>
        <dd>{user.id}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
      </dl>
      <h2>Notifications</h2>
      <ul>
        {notifications.map((notification) => (
          <li>{notification}</li>
        ))}
      </ul>
      <p>
        <a href="/">Back to root</a>
      </p>
    </main>
  )
}
