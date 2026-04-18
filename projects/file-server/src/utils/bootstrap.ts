import { stat } from "node:fs/promises"
import { getUsersFilePath, MASTER_ADMIN_USERNAME } from "./auth"
import { loadUsersFromFileWithCache, saveUsersToFile } from "./userConfigCache"

export async function bootstrapAdminUser(
	uploadDir: string,
	initialAdminPassword?: string,
): Promise<void> {
	const usersFile = getUsersFilePath(uploadDir)

	let fileExists = false
	try {
		await stat(usersFile)
		fileExists = true
	} catch {
		// File doesn't exist
	}

	if (fileExists) {
		const users = await loadUsersFromFileWithCache(usersFile)

		if (users.length > 0) {
			const admin = users.find((u) => u.username === MASTER_ADMIN_USERNAME)
			if (!admin) {
				throw new Error(
					`[FATAL] Users file is non-empty but missing '${MASTER_ADMIN_USERNAME}' user.`,
				)
			}
			if (admin.role !== "admin") {
				throw new Error(
					`[FATAL] '${MASTER_ADMIN_USERNAME}' user must have role 'admin'.`,
				)
			}
			return
		}
	}

	const password = initialAdminPassword ?? generateRandomPassword()
	const passwordHash = await Bun.password.hash(password, {
		algorithm: "bcrypt",
		cost: 12,
	})

	await saveUsersToFile(usersFile, [
		{
			username: MASTER_ADMIN_USERNAME,
			passwordHash,
			role: "admin",
			sessionVersion: 0,
		},
	])

	if (!initialAdminPassword) {
		console.log(`[BOOTSTRAP] Initial admin password: ${password}`)
		console.log("[BOOTSTRAP] Change this password after your first login.")
	}
}

function generateRandomPassword(): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => chars[b % chars.length]).join("")
}
