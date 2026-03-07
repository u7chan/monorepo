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
}

export type AppBindings = {
  Bindings: {
    UPLOAD_DIR: string
    SESSION_SECRET?: string
    USERS_FILE?: string
  }
  Variables: {
    user: UserState
  }
}
