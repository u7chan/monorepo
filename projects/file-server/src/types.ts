export type AuthenticatedUser = { type: "authenticated"; username: string }
export type AnonymousUser = { type: "anonymous" }
export type UserState = AuthenticatedUser | AnonymousUser

export type UserConfig = {
	username: string
	passwordHash: string
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
