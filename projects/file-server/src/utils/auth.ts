import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import type { UserConfig, UserState } from "../types"

const USERNAME_PATTERN = /^[a-z0-9_-]+$/
const RESERVED_USERNAMES = new Set(["public", "private"])
export const SESSION_COOKIE_NAME = "session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7
export const DEFAULT_UPLOAD_DIR = "./tmp"
export const MASTER_ADMIN_USERNAME = "admin"

export function getUsersFilePath(uploadDir: string): string {
	return path.join(uploadDir, ".auth", "users.json")
}

export function validateAuthConfig(sessionSecret: string | undefined): void {
	if (sessionSecret && sessionSecret.length < 32) {
		console.warn("[WARN] SESSION_SECRET should be at least 32 characters long.")
	}
}

export function findUser(users: UserConfig[] | null, username: string): UserConfig | null {
	if (!users) {
		return null
	}
	return users.find((user) => user.username === username) ?? null
}

export function isValidUsername(username: string): boolean {
	return USERNAME_PATTERN.test(username) && !RESERVED_USERNAMES.has(username)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	try {
		return await Bun.password.verify(password, hash)
	} catch {
		return false
	}
}

function signValue(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url")
}

function safeStringEqual(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	if (left.length !== right.length) {
		return false
	}
	return timingSafeEqual(left, right)
}

export async function signSession(
	payload: { username: string; sessionVersion: number },
	secret: string,
): Promise<string> {
	if (!isValidUsername(payload.username)) {
		throw new Error("Invalid username for session payload.")
	}
	const data = `${payload.username}:${payload.sessionVersion}`
	const signature = signValue(data, secret)
	return `${data}:${signature}`
}

export async function verifySession(
	cookieValue: string,
	secret: string,
): Promise<{ username: string; sessionVersion: number } | null> {
	const lastColon = cookieValue.lastIndexOf(":")
	if (lastColon <= 0 || lastColon === cookieValue.length - 1) {
		return null
	}

	const data = cookieValue.slice(0, lastColon)
	const signature = cookieValue.slice(lastColon + 1)

	const firstColon = data.indexOf(":")
	if (firstColon <= 0) {
		return null
	}

	const username = data.slice(0, firstColon)
	const versionStr = data.slice(firstColon + 1)
	const sessionVersion = Number(versionStr)

	if (!isValidUsername(username)) {
		return null
	}
	if (!Number.isInteger(sessionVersion) || sessionVersion < 0) {
		return null
	}

	const expectedSignature = signValue(data, secret)
	if (!safeStringEqual(signature, expectedSignature)) {
		return null
	}

	return { username, sessionVersion }
}

export function getUserUploadDir(baseDir: string, userState: UserState): string {
	if (userState.type === "authenticated" && userState.role === "user") {
		return path.join(baseDir, "private", userState.username)
	}
	return baseDir
}

export function getUserHomeVirtualPath(userState: UserState): string | null {
	if (userState.type !== "authenticated" || userState.role !== "user") {
		return null
	}
	return `private/${userState.username}`
}

export function isUserHomeVirtualPath(userState: UserState, virtualPath: string): boolean {
	const homePath = getUserHomeVirtualPath(userState)
	if (!homePath) {
		return false
	}
	return virtualPath === "" || virtualPath === "private" || virtualPath === homePath
}

export function toBrowseLocation(userState: UserState, virtualPath: string): string {
	return isUserHomeVirtualPath(userState, virtualPath) ? "" : virtualPath
}

export function normalizeReturnTo(value: string | null | undefined): string {
	if (!value) {
		return "/"
	}
	if (!value.startsWith("/") || value.startsWith("//")) {
		return "/"
	}
	return value
}
