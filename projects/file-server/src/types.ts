export type UserRole = "admin" | "user"

export type AuthenticatedUser = {
  type: "authenticated"
  username: string
  role: UserRole
}
export type AnonymousUser = { type: "anonymous" }
export type UserState = AuthenticatedUser | AnonymousUser

export type UserConfig = {
  username: string
  passwordHash: string
  role: UserRole
  sessionVersion: number
}

export type AppBindings = {
  Bindings: {
    AUTH_DIR?: string
    UPLOAD_DIR: string
    INITIAL_ADMIN_PASSWORD?: string
  }
  Variables: {
    user: UserState
  }
}
