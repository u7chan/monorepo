import { randomBytes } from "node:crypto"

export type ResolvedToken = {
  value: string
  source: "env" | "generated"
}

const TOKEN_BYTES = 32

export function resolveToken(env: NodeJS.ProcessEnv): ResolvedToken {
  const fromEnv = env.HERDR_CLIENT_TOKEN?.trim()

  if (fromEnv) {
    return { value: fromEnv, source: "env" }
  }

  return { value: randomBytes(TOKEN_BYTES).toString("hex"), source: "generated" }
}
