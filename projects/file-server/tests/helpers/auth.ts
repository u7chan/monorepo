import { SESSION_COOKIE_NAME, signSession } from "../../src/utils/auth"

export interface TestSession {
	cookie: string
	username: string
}

export async function createTestSession(
	username: string,
	secret: string,
	sessionVersion = 0,
): Promise<TestSession> {
	const sessionValue = await signSession({ username, sessionVersion }, secret)
	return {
		cookie: `${SESSION_COOKIE_NAME}=${sessionValue}`,
		username,
	}
}
