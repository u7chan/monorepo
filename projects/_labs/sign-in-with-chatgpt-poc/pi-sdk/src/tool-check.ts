import { createBashTool } from "@earendil-works/pi-coding-agent"

export interface ToolEnvironmentReport {
  /** 親プロセスの env に置いたダミー変数名 */
  prototypeVariable: string
  /** 確認対象の変数名 → 子プロセスから見えた値（未設定なら undefined） */
  observed: Record<string, string | undefined>
  /** 子プロセスの env に存在してはいけない値 → 見つかったか */
  leaked: Record<string, boolean>
  /** Pi がシェルツールへ注入するセッション変数 */
  sessionVariables: Record<string, string | undefined>
}

export interface ToolFileAccessReport {
  /** ツール子プロセスから資格情報ファイルを読めるか（`test -r`） */
  readable: boolean
  /** 読めた内容が保存済み資格情報の形をしているか（値そのものは返さない） */
  containsCredentialShape: boolean
}

const ENVIRONMENT_MARKER = "__FILE_ACCESS__"

/** ツール出力（`env` の結果 + ファイルアクセス確認）を組み立てるコマンド */
export function buildToolCheckCommand(authPath: string): string {
  return `env; printf '\\n%s\\n' '${ENVIRONMENT_MARKER}'; test -r ${shellQuote(authPath)} && echo READABLE || echo NOT_READABLE`
}

export function splitToolCheckOutput(output: string): {
  environment: string
  fileAccess: string
} {
  const index = output.indexOf(ENVIRONMENT_MARKER)
  if (index < 0) {
    return { environment: output, fileAccess: "" }
  }
  return {
    environment: output.slice(0, index),
    fileAccess: output.slice(index + ENVIRONMENT_MARKER.length),
  }
}

/**
 * ツール子プロセスの env 出力を解釈する。
 * Pi のシェル環境は親プロセスの env をそのまま引き継ぐため、資格情報を env で渡した場合は
 * 継承される。ここでは「見えている / 見えていない」だけを事実として返す。
 */
export function parseEnvironmentReport(
  environmentOutput: string,
  options: {
    /** 親プロセスの env に置いたダミー変数名 */
    prototypeVariable: string
    /** 子プロセスの env に存在してはいけない値 */
    secretValues: Record<string, string>
  },
): ToolEnvironmentReport {
  const entries = new Map<string, string>()
  for (const line of environmentOutput.split("\n")) {
    const index = line.indexOf("=")
    if (index <= 0) {
      continue
    }
    entries.set(line.slice(0, index), line.slice(index + 1))
  }

  const leaked: Record<string, boolean> = {}
  for (const [label, value] of Object.entries(options.secretValues)) {
    leaked[label] = value.length > 0 && environmentOutput.includes(value)
  }

  return {
    prototypeVariable: options.prototypeVariable,
    observed: {
      [options.prototypeVariable]: entries.get(options.prototypeVariable),
      OPENAI_API_KEY: entries.get("OPENAI_API_KEY"),
    },
    leaked,
    sessionVariables: {
      PI_PROVIDER: entries.get("PI_PROVIDER"),
      PI_MODEL: entries.get("PI_MODEL"),
      PI_REASONING_LEVEL: entries.get("PI_REASONING_LEVEL"),
      PI_SESSION_ID: entries.get("PI_SESSION_ID"),
    },
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * ツール子プロセスから資格情報ファイルが読めるかを確認する。
 * 同じ OS ユーザーで動く以上、ファイル権限だけではツールを止められないことを記録するため。
 */
export async function inspectToolFileAccess(options: {
  cwd: string
  path: string
}): Promise<ToolFileAccessReport> {
  const tool = createBashTool(options.cwd)
  const content = async (toolCallId: string, command: string) => {
    const result = await tool.execute(toolCallId, { command })
    return result.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
  }

  const readable = (
    await content(
      "tool-file-access",
      `test -r ${shellQuote(options.path)} && echo yes || echo no`,
    )
  )
    .trim()
    .split("\n")
    .at(-1)
  if (readable !== "yes") {
    return { readable: false, containsCredentialShape: false }
  }

  const fileContent = await content(
    "tool-file-read",
    `cat ${shellQuote(options.path)}`,
  )
  return {
    readable: true,
    containsCredentialShape:
      fileContent.includes('"type"') && fileContent.includes('"access"'),
  }
}
