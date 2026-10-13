import { createInterface } from "node:readline/promises"

/**
 * `runtime.login()` に渡す最小の対話実装。
 *
 * Pi 本体は TUI で同意 URL を表示し、コールバックが届かない場合に
 * 最終リダイレクト URL の貼り付けを受け付ける。CLI でも同じ 2 経路を用意するが、
 * 非対話（stdin が TTY でない）では貼り付け経路を無効にしてコールバックのみを待つ。
 */
export interface LoginPrompt {
  type: string
  message: string
  placeholder?: string
  signal?: AbortSignal
}

export interface LoginEvent {
  type: "info" | "auth_url" | "device_code" | "progress"
  message?: string
  url?: string
  instructions?: string
}

export interface LoginUi {
  authUrl(url: string, instructions?: string): void
  progress(message: string): void
  info(message: string): void
}

export interface LoginInteraction {
  signal: AbortSignal
  prompt(prompt: LoginPrompt): Promise<string>
  notify(event: LoginEvent): void
  /** 進行中のログインを中断する（Ctrl+C など） */
  abort(): void
}

export interface LoginInteractionOptions {
  ui: LoginUi
  stdin?: { isTTY?: boolean } & NodeJS.ReadStream
  signal?: AbortSignal
}

/** abort されるまで解決しない promise。非対話環境で貼り付け入力を待たないために使う。 */
function pendingUntilAborted(signal?: AbortSignal): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    if (!signal) {
      return
    }
    if (signal.aborted) {
      reject(new Error("Login cancelled"))
      return
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("Login cancelled")),
      { once: true },
    )
  })
}

export function createLoginInteraction(
  options: LoginInteractionOptions,
): LoginInteraction {
  const stdin = options.stdin ?? process.stdin
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal

  async function promptManualCode(prompt: LoginPrompt): Promise<string> {
    if (!stdin.isTTY) {
      return pendingUntilAborted(prompt.signal ?? signal)
    }

    const readline = createInterface({ input: stdin })
    const onAbort = () => readline.close()
    prompt.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const answer = await readline.question(`${prompt.message}\n> `)
      return answer
    } finally {
      prompt.signal?.removeEventListener("abort", onAbort)
      readline.close()
    }
  }

  return {
    signal,
    abort() {
      controller.abort()
    },
    prompt: promptManualCode,
    notify(event) {
      if (event.type === "auth_url") {
        options.ui.authUrl(event.url ?? "", event.instructions)
        return
      }
      if (event.type === "info") {
        options.ui.info(event.message ?? "")
        return
      }
      if (event.type === "device_code") {
        options.ui.info(`device code: ${event.message ?? ""}`)
        return
      }
      options.ui.progress(event.message ?? "")
    },
  }
}
