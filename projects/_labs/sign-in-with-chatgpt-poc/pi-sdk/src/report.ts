import type { AuthReport } from "./auth.js"
import type { RequestSummary, ResponseSummary } from "./recorder.js"
import type {
  ToolEnvironmentReport,
  ToolFileAccessReport,
} from "./tool-check.js"

export function printHeader(title: string): void {
  console.log(`\n== ${title} ==`)
}

export function printKeyValues(
  rows: Array<[string, string | number | boolean | undefined]>,
): void {
  for (const [key, value] of rows) {
    if (value === undefined) {
      continue
    }
    console.log(`${key}: ${value}`)
  }
}

export function printAuthReport(report: AuthReport): void {
  printHeader("認証状態（Pi SDK の公開 API から取得）")
  printKeyValues([
    ["provider", report.provider],
    ["configured", report.configured],
    ["source", report.source],
    ["label", report.label],
    ["credential type", report.credentialType],
    ["isUsingOAuth", report.usingOAuth],
    ["isUsingSubscription", report.usingSubscription],
    ["refresh token", report.hasRefreshToken],
    [
      "expires at",
      report.expiresAt === undefined
        ? undefined
        : new Date(report.expiresAt).toISOString(),
    ],
    ["expires in (s)", report.expiresInSeconds],
    ["client id", report.clientId],
    ["scopes", report.scopes?.join(" ")],
  ])

  printHeader("別経路（openai-codex）の状態")
  printKeyValues([
    ["configured", report.codex.configured],
    ["isUsingOAuth", report.codex.usingOAuth],
    ["isUsingSubscription", report.codex.usingSubscription],
  ])
  console.log(
    report.codex.configured
      ? "※ openai-codex にも資格情報があります。推論に使った経路は上の openai の値と、リクエスト先 baseUrl で判別します。"
      : "※ openai-codex は未設定です。SIWC 経路（provider=openai）だけで動かしています。",
  )
}

function formatRequest(summary: RequestSummary): string {
  const parts = [
    `model=${summary.model}`,
    `store=${summary.store}`,
    `stream=${summary.stream}`,
    `input=${summary.inputItems}`,
    `inputRoles=[${summary.inputRoles.join(",")}]`,
    `tools=[${summary.toolNames.join(",")}]`,
    `reasoning.effort=${summary.reasoningEffort ?? "-"}`,
    `include=[${(summary.include ?? []).join(",")}]`,
    `prompt_cache_key=${summary.hasPromptCacheKey}`,
    `prompt_cache_retention=${summary.promptCacheRetention ?? "-"}`,
    `max_output_tokens=${summary.maxOutputTokens ?? "-"}`,
    `temperature=${summary.temperature ?? "-"}`,
    `instructions=${summary.hasInstructions}`,
  ]
  return parts.join(" ")
}

function formatResponse(summary: ResponseSummary): string {
  return [
    `status=${summary.status}`,
    `requestId=${summary.requestId ?? "-"}`,
    `openai-version=${summary.openaiVersion ?? "-"}`,
  ].join(" ")
}

export function printRequestSummaries(
  requests: RequestSummary[],
  responses: ResponseSummary[],
): void {
  printHeader(
    "実際に送られた provider リクエスト（トークン・ヘッダー値は含まない）",
  )
  if (requests.length === 0) {
    console.log("リクエストは記録されませんでした。")
    return
  }
  requests.forEach((request, index) => {
    console.log(`request[${index}] ${formatRequest(request)}`)
    console.log(`  keys: ${request.topLevelKeys.join(", ")}`)
  })
  responses.forEach((response, index) => {
    console.log(`response[${index}] ${formatResponse(response)}`)
  })
}

export function printToolEnvironmentReport(
  report: ToolEnvironmentReport,
  fileAccess: ToolFileAccessReport,
): void {
  printHeader("ツール子プロセスの環境変数（実測）")
  printKeyValues(
    Object.entries(report.observed).map(([key, value]) => [
      `${key} → 子プロセス`,
      value ?? "(未設定)",
    ]),
  )

  printHeader("資格情報の継承チェック")
  for (const [label, leaked] of Object.entries(report.leaked)) {
    console.log(`${leaked ? "継承された" : "継承されなかった"}: ${label}`)
  }

  printHeader("環境変数を経由した場合の比較（危険側の実測）")
  console.log(
    report.observed[report.prototypeVariable] === undefined
      ? `env に置いたダミー値（${report.prototypeVariable}）は子プロセスへ届きませんでした。`
      : `env に置いたダミー値（${report.prototypeVariable}）は子プロセスへそのまま届きます。SIWC トークンを env で渡すとツールへ継承されます。`,
  )

  printHeader("Pi が注入するセッション変数")
  printKeyValues(
    Object.entries(report.sessionVariables).map(([key, value]) => [
      key,
      value ?? "(未設定)",
    ]),
  )

  printHeader("資格情報ファイルへのアクセス（同一 OS ユーザー）")
  printKeyValues([
    ["tool から auth.json を読める", fileAccess.readable],
    [
      "読み取った内容が資格情報の形をしている",
      fileAccess.containsCredentialShape,
    ],
  ])
  console.log(
    "※ 保存先を 0600 にしても、同じ OS ユーザーで動くツールは読めます。出力マスクは安全境界になりません。",
  )
}
