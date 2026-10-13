import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createLoginInteraction, type LoginEvent } from "../src/login.js"

function createUi() {
  const events: {
    authUrls: string[]
    instructions: (string | undefined)[]
    progresses: string[]
    infos: string[]
  } = {
    authUrls: [],
    instructions: [],
    progresses: [],
    infos: [],
  }
  return {
    events,
    ui: {
      authUrl(url: string, instructions?: string) {
        events.authUrls.push(url)
        events.instructions.push(instructions)
      },
      progress(message: string) {
        events.progresses.push(message)
      },
      info(message: string) {
        events.infos.push(message)
      },
    },
  }
}

describe("createLoginInteraction", () => {
  test("notify の種別ごとに UI へ振り分ける", () => {
    const { events, ui } = createUi()
    const interaction = createLoginInteraction({
      ui,
      stdin: { isTTY: false } as never,
    })

    interaction.notify({
      type: "auth_url",
      url: "https://example.com/auth",
      instructions: "open it",
    })
    interaction.notify({ type: "progress", message: "exchanging" })
    interaction.notify({ type: "info", message: "note" } as LoginEvent)

    expect(events.authUrls).toEqual(["https://example.com/auth"])
    expect(events.instructions).toEqual(["open it"])
    expect(events.progresses).toEqual(["exchanging"])
    expect(events.infos).toEqual(["note"])
  })

  test("非対話 stdin では貼り付け入力を待ち続け、abort で中断する", async () => {
    const { ui } = createUi()
    const interaction = createLoginInteraction({
      ui,
      stdin: { isTTY: false } as never,
    })

    const prompt = interaction.prompt({ type: "manual_code", message: "paste" })
    const aborted = prompt.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    )
    interaction.abort()
    expect(await aborted).toBe("Login cancelled")
  })

  test("abort 済みの signal では即座に中断する", async () => {
    const { ui } = createUi()
    const controller = new AbortController()
    controller.abort()
    const interaction = createLoginInteraction({
      ui,
      stdin: { isTTY: false } as never,
      signal: controller.signal,
    })

    await expect(
      interaction.prompt({ type: "manual_code", message: "paste" }),
    ).rejects.toThrow("Login cancelled")
  })

  test("TTY の貼り付け待ちも abort で終了する", async () => {
    const { ui } = createUi()
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    Object.assign(stdin, { isTTY: true })
    const interaction = createLoginInteraction({ ui, stdin })

    const pending = interaction.prompt({
      type: "manual_code",
      message: "paste",
    })
    // readline が待機に入ってから中断する
    await new Promise((resolve) => setTimeout(resolve, 20))
    interaction.abort()

    await expect(pending).rejects.toThrow("Login cancelled")
  })

  test("prompt 個別の signal でも貼り付け待ちを終了する", async () => {
    const { ui } = createUi()
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    Object.assign(stdin, { isTTY: true })
    const interaction = createLoginInteraction({ ui, stdin })

    const promptController = new AbortController()
    const pending = interaction.prompt({
      type: "manual_code",
      message: "paste",
      signal: promptController.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    promptController.abort()

    await expect(pending).rejects.toThrow("Login cancelled")
  })
})
