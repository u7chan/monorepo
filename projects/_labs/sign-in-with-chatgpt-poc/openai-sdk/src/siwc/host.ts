import { join } from "node:path"
import { readStringProperty } from "./fetch"
import { createHostId } from "./pkce"
import { readJsonFile, writeJsonFile } from "./storage"

export const HOST_FILE_NAME = "chatgpt-host.json"

/**
 * host ID は「このインストール」を表す不変の識別子。
 * ChatGPT アカウントを切り替えても作り直さない。
 */
export async function loadOrCreateHostId(
  directory: string,
  appName: string,
): Promise<string> {
  const filePath = join(directory, HOST_FILE_NAME)
  const existing = await readJsonFile(filePath)
  const existingId = readStringProperty(existing, "extAgentHostId")
  if (typeof existingId === "string" && existingId.startsWith("urn:uuid:")) {
    return existingId
  }

  const extAgentHostId = createHostId()
  await writeJsonFile(filePath, {
    extAgentHostId,
    appName,
    updatedAt: new Date().toISOString(),
  })
  return extAgentHostId
}
