import { readFileSync } from "node:fs"
import { VERSION } from "@earendil-works/pi-coding-agent"
import { runTurn } from "./agent.js"
import {
  assertSiwcCredential,
  createModelRuntime,
  describeAuth,
  forceExpireStoredToken,
  forceInvalidStoredToken,
  loginWithSiwc,
  logoutWithSiwc,
  SIWC_PROVIDER,
} from "./auth.js"
import { ENV_NAMES, loadConfig } from "./config.js"
import { createLoginInteraction } from "./login.js"
import {
  printAuthReport,
  printHeader,
  printKeyValues,
  printRequestSummaries,
  printToolEnvironmentReport,
} from "./report.js"
import { runStubSession } from "./stub-session.js"
import {
  buildToolCheckCommand,
  inspectToolFileAccess,
  parseEnvironmentReport,
  splitToolCheckOutput,
} from "./tool-check.js"

const DUMMY_VARIABLE = "SIWC_PI_DUMMY_TOKEN"

function usage(): void {
  console.log(`sign-in-with-chatgpt-poc / pi-sdk — Pi SDK + Sign in with ChatGPT

使い方:
  bun run start login            SIWC でサインインする（Pi 組み込みの OAuth 実装）
  bun run start logout           保存済みの資格情報を削除する
  bun run start status           認証経路・SDK バージョン・モデルを表示する
  bun run start ask "<prompt>"   最小のエージェントセッションで 1 ターン推論する
  bun run start expire           アクセストークンの期限だけを過去にずらす（更新の確認用）
  bun run start fake-token       アクセストークンをダミー値にする（401 の確認用）
  bun run start check-tools      ツール子プロセスへ資格情報が継承されないか確認する

ask のオプション:
  --tools bash,read              有効にするツール（既定はツールなし）
  --follow "<prompt>"            同じセッションで続けて送る 2 ターン目の入力

環境変数:
  ${ENV_NAMES.storageDir}   資格情報の保存先（既定: $XDG_CONFIG_HOME/sign-in-with-chatgpt-poc/pi-sdk）
  ${ENV_NAMES.model}        使用モデル（既定: gpt-6-luna）
  ${ENV_NAMES.thinking}     thinking level（既定: medium）
  ${ENV_NAMES.agentName}    同意画面に出るアプリ名
  ${ENV_NAMES.workspace}    ツールの作業ディレクトリ（既定: カレントディレクトリ）
`)
}

function parseAskArgs(args: string[]): {
  prompt: string
  tools?: string[]
  followUpPrompt?: string
} {
  const words: string[] = []
  let tools: string[] | undefined
  let followUpPrompt: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--tools" || arg === "--follow") {
      const value = args[index + 1]
      if (value === undefined) {
        throw new Error(`${arg} には値が必要です`)
      }
      if (arg === "--tools") {
        tools = value
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      } else {
        followUpPrompt = value
      }
      index += 1
      continue
    }
    if (arg?.startsWith("--")) {
      throw new Error(`不明なオプションです: ${arg}`)
    }
    if (arg !== undefined) {
      words.push(arg)
    }
  }

  const prompt = words.join(" ").trim()
  if (prompt.length === 0) {
    throw new Error("prompt が必要です")
  }
  return { prompt, tools, followUpPrompt }
}

async function commandStatus(): Promise<void> {
  const config = loadConfig()
  const runtime = await createModelRuntime(config)

  printHeader("実行時の値")
  printKeyValues([
    ["pi-coding-agent", VERSION ?? "(unknown)"],
    ["storage dir", config.storageDir],
    ["auth file", config.authPath],
    ["device id file", config.deviceIdPath],
    ["model (設定値)", config.modelId],
    ["thinking level", config.thinkingLevel],
    ["workspace", config.workspace],
  ])

  const model = runtime.getModel(SIWC_PROVIDER, config.modelId)
  printHeader("選択モデル（Pi の同梱カタログ）")
  if (model) {
    printKeyValues([
      ["provider", model.provider],
      ["model", model.id],
      ["api", model.api],
      ["baseUrl", model.baseUrl],
      ["reasoning", model.reasoning],
      ["context window", model.contextWindow],
    ])
  } else {
    console.log(`カタログにありません: ${SIWC_PROVIDER}/${config.modelId}`)
  }
  console.log(
    `カタログ上の ${SIWC_PROVIDER} モデル数: ${runtime.getModels(SIWC_PROVIDER).length}`,
  )

  printAuthReport(await describeAuth(runtime, config))

  const error = runtime.getError()
  if (error) {
    printHeader("model runtime のエラー")
    console.log(error)
  }
}

async function commandLogin(): Promise<void> {
  const config = loadConfig()
  const runtime = await createModelRuntime(config)
  const interaction = createLoginInteraction({
    ui: {
      authUrl(url, instructions) {
        printHeader("ブラウザでサインインしてください")
        console.log(url)
        if (instructions) {
          console.log(instructions)
        }
      },
      progress(message) {
        console.log(message)
      },
      info(message) {
        console.log(message)
      },
    },
  })

  const onSigint = () => {
    console.log("\nキャンセルします。")
    interaction.abort()
  }
  process.once("SIGINT", onSigint)

  try {
    await loginWithSiwc(runtime, config, interaction)
  } finally {
    process.removeListener("SIGINT", onSigint)
  }

  printAuthReport(await describeAuth(runtime, config))
}

async function commandLogout(): Promise<void> {
  const config = loadConfig()
  const runtime = await createModelRuntime(config)
  await logoutWithSiwc(runtime)
  printAuthReport(await describeAuth(runtime, config))
}

async function commandExpire(): Promise<void> {
  const config = loadConfig()
  const expired = forceExpireStoredToken(config)
  console.log(
    expired
      ? "アクセストークンの期限を過去にしました。"
      : "OAuth 資格情報が見つかりませんでした。先に login してください。",
  )
}

async function commandFakeToken(): Promise<void> {
  const config = loadConfig()
  const updated = forceInvalidStoredToken(config)
  console.log(
    updated
      ? "アクセストークンをダミー値にし、期限は未来のままにしました。"
      : "OAuth 資格情報が見つかりませんでした。先に login してください。",
  )
}

async function commandAsk(args: string[]): Promise<void> {
  const config = loadConfig()
  const { prompt, tools, followUpPrompt } = parseAskArgs(args)
  const runtime = await createModelRuntime(config)

  const report = await describeAuth(runtime, config)
  assertSiwcCredential(report)

  const before = report.expiresInSeconds
  console.log(
    `thinking level: ${config.thinkingLevel} / tools: ${tools?.join(",") ?? "(なし)"}`,
  )

  let streamed = false
  const result = await runTurn(runtime, config, {
    prompt,
    ...(followUpPrompt ? { followUpPrompt } : {}),
    ...(tools ? { tools } : {}),
    onTurnStart: (index, turnPrompt) => {
      if (index > 0) {
        process.stdout.write("\n")
      }
      console.log(`\n[turn ${index + 1}] ${turnPrompt}`)
    },
    onThinkingDelta: () => {
      streamed = true
    },
    onTextDelta: (delta) => {
      streamed = true
      process.stdout.write(delta)
    },
    onToolStart: (toolName) => {
      console.log(`\n[tool] ${toolName}`)
    },
  })
  if (streamed) {
    process.stdout.write("\n")
  }

  printHeader("回答")
  for (const [index, answer] of result.answers.entries()) {
    console.log(`turn ${index + 1}: ${answer}`)
  }
  if (result.stopReason !== undefined) {
    console.log(`stopReason: ${result.stopReason}`)
  }
  if (result.errorMessage !== undefined) {
    printHeader("エラー")
    console.log(result.errorMessage)
    process.exitCode = 1
  }

  printHeader("推論に使われた経路")
  printKeyValues([
    ["provider", result.provider],
    ["model", result.modelId],
    ["api", result.api],
    ["baseUrl", result.baseUrl],
    ["thinking level (適用後)", result.thinkingLevel],
    ["messages", result.messageCount],
  ])

  printRequestSummaries(result.requests, result.responses)

  const after = (await describeAuth(runtime, config)).expiresInSeconds
  if (before !== undefined && after !== undefined && after > before) {
    printHeader("トークン更新")
    console.log(
      `アクセストークンが更新されました（残り ${before}s → ${after}s）。`,
    )
  }
}

async function commandCheckTools(): Promise<void> {
  const config = loadConfig()
  const runtime = await createModelRuntime(config)
  const report = await describeAuth(runtime, config)

  const dummy = `dummy-${process.pid}-${Date.now()}`
  process.env[DUMMY_VARIABLE] = dummy

  const secretValues: Record<string, string> = { "dummy env value": dummy }
  const stored = (() => {
    try {
      return JSON.parse(readFileSync(config.authPath, "utf-8")) as Record<
        string,
        { access?: string }
      >
    } catch {
      return undefined
    }
  })()
  const accessToken = stored?.[SIWC_PROVIDER]?.access
  if (typeof accessToken === "string" && accessToken.length > 0) {
    secretValues["保存済み access token"] = accessToken
  }
  if (!report.configured) {
    console.log(
      "※ 未サインインのため、保存済みトークンの継承チェックはダミー値のみで行います。",
    )
  }

  const session = await runStubSession(config, {
    prompt: "self check",
    toolCommand: buildToolCheckCommand(config.authPath),
  })
  const { environment: environmentOutput, fileAccess: fileAccessOutput } =
    splitToolCheckOutput(session.toolOutput)
  const environment = parseEnvironmentReport(environmentOutput, {
    prototypeVariable: DUMMY_VARIABLE,
    secretValues,
  })
  const fileAccess = await inspectToolFileAccess({
    cwd: config.workspace,
    path: config.authPath,
  })

  printHeader("スタブ provider 経由のエージェントセッション")
  printKeyValues([
    ["prompt", "self check"],
    ["tools", "bash"],
    ["stub の応答本文", session.result.text],
    ["ツール出力のファイルアクセス結果", fileAccessOutput.trim()],
  ])

  printToolEnvironmentReport(environment, fileAccess)
  printKeyValues([
    ["auth file", config.authPath],
    ["dummy variable", DUMMY_VARIABLE],
  ])
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case "status":
      await commandStatus()
      return
    case "login":
      await commandLogin()
      return
    case "logout":
      await commandLogout()
      return
    case "ask":
      await commandAsk(args)
      return
    case "expire":
      await commandExpire()
      return
    case "fake-token":
      await commandFakeToken()
      return
    case "check-tools":
      await commandCheckTools()
      return
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage()
      return
    default:
      usage()
      throw new Error(`不明なコマンドです: ${command}`)
  }
}

await main()
