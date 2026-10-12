import { createApp } from "./app"
import { loadConfig } from "./config"
import { REDIRECT_HOST } from "./siwc/constants"

const config = loadConfig()
const app = createApp(config)

// 起動時にブラウザを開く子プロセスは作らない（資格情報を継承させないため）
console.log(`sign-in-with-chatgpt-poc (openai-sdk): ${config.origin}/`)
console.log(`  資格情報の保存先: ${config.storageDir}`)
console.log(`  デバッグ操作: ${config.enableDebugActions ? "有効" : "無効"}`)

export default {
  port: config.port,
  hostname: REDIRECT_HOST,
  fetch: app.fetch,
}
