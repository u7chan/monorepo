/**
 * BFF ローカルの `serve` ツール。サンドボックスへ送るリモート定義とは別の層で、
 * 起動・停止の実処理は GUI と同じ `ServeService` を共有する (docs/sandbox.md)。
 * 所有者はモデルに申告させず、ツール定義の生成時に渡した会話 id へ束縛する。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { builtinSkillEnabled } from "./builtin-skills";
import type { ServeStatus } from "./schema";
import type { DebugServeHandle, DebugServeStatus, DebugServeStopResult, ServeService } from "./serve";

export const SERVE_TOOL_NAME = "serve";

export const SERVE_TOOL_DESCRIPTION =
  "Start, stop, or check the app served to the user's browser (the UI calls it a service), and run a private debug server for your own verification. " +
  "The app the user opens must listen on 0.0.0.0:8080; starting replaces whatever is served now, and the conversation that starts it becomes the owner shown in the UI. " +
  "A debug server listens on 127.0.0.1 with a port from 18000-18099, is not shown in the UI, and exists only for your own checks (curl, screenshots).";

/**
 * モデルへ渡す説明。ビルトイン skill を外したセッションでは、存在しない skill を指さない
 * (system prompt の serveSkillClause と同じ判定に揃える)。
 */
function serveToolDescription(
  builtinSkillNames: readonly string[] | undefined,
  allowNaturalInvocation: boolean | undefined,
): string {
  return builtinSkillEnabled("serve", builtinSkillNames) && allowNaturalInvocation !== false
    ? `${SERVE_TOOL_DESCRIPTION} Follow the bundled \`serve\` skill for the command and verification loop.`
    : SERVE_TOOL_DESCRIPTION;
}

export const SERVE_TOOL_GUIDELINES = [
  "Use the serve tool instead of starting a background server with bash: only this path records the owner and the start command.",
  "After a start, verify the result with the serve tool (status) and tell the user the URL comes from the UI's service button.",
  "Use debug_start for your own verification and start only to show the app to the user: the two are separate servers, and a debug server never replaces what the user sees.",
  "A debug server takes one port per conversation from 18000-18099 and the port changes on every start, so read it from the tool result instead of reusing an old one. Bind it to 127.0.0.1.",
  "Stop a debug server with debug_stop when the checks are done; it does not stop when the run ends.",
  "Never put secret values in `command` and never ask the user to paste them into the chat: the user registers environment variables in the Work Environment panel and the app reads them from process.env.",
  'Environment variables registered there also reach bash, but secrets reach only the process started by start or debug_start, so verify presence (`[ -n "${NAME+x}" ]` in bash, `"NAME" in process.env` in the started process) instead of reading the value; `[REDACTED]` shows the masker worked, not that the value was injected.',
];

const serveSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("start"),
      Type.Literal("stop"),
      Type.Literal("status"),
      Type.Literal("debug_start"),
      Type.Literal("debug_stop"),
      Type.Literal("debug_status"),
    ],
    {
      description:
        "start / stop / status: the app served to the user on 0.0.0.0:8080. debug_start / debug_stop / debug_status: a private 127.0.0.1 server for your own verification.",
    },
  ),
  command: Type.Optional(
    Type.String({
      description:
        "start / debug_start only: the shell command to run. It runs in the conversation's working directory. " +
        "For start: for example `pnpm dev --host 0.0.0.0 --port 8080 --strictPort` (recorded as the start command for that directory). " +
        "For debug_start: bind to 127.0.0.1 and read the port from $U7AGENT_DEBUG_PORT, for example `pnpm dev --host 127.0.0.1 --port $U7AGENT_DEBUG_PORT` (not recorded).",
    }),
  ),
});
type ServeParams = Static<typeof serveSchema>;

/** モデルへ返す状態の要約。UI の表示と混ざらないよう、操作に必要な事実だけを英語で返す */
export function describeServeStatus(status: ServeStatus): string {
  const lines: string[] = [];
  const owner = status.owner;
  if (status.reachable) {
    const who =
      owner.kind === "mine"
        ? "started by this conversation"
        : owner.kind === "other"
          ? `started by another conversation (${owner.title ?? "unknown"})`
          : "started outside this app (no matching record)";
    lines.push(`served app: reachable on port 8080 (${who})`);
  } else {
    lines.push("served app: not reachable (nothing is listening on port 8080)");
  }
  lines.push(
    status.command
      ? `start command for this working directory: ${status.command.command}`
      : "start command for this working directory: none (nothing has been served successfully here yet)",
  );
  if (status.reachable && owner.kind !== "mine") {
    lines.push(
      "Starting again stops the current process and replaces it. Anyone may stop a process started outside this app.",
    );
  }
  return lines.join("\n");
}

/** モデルへ返すデバッグ用 serve の起動結果。ユーザーの UI に出ないことを明示する (**同じ URL をユーザーへ案内させない**) */
export function describeDebugStart(handle: DebugServeHandle): string {
  return [
    `debug server: listening on http://127.0.0.1:${handle.port}/ (this conversation only, not shown in the user's service UI)`,
    `log: ${handle.logPath}`,
    `Verify with \`curl -fsS http://127.0.0.1:${handle.port}/\` or the bundled \`browser\` skill. Use the serve tool's start action on 0.0.0.0:8080 only when the user should see the app.`,
  ].join("\n");
}

/** デバッグ用 serve の状態。追跡外はポートだけを返し、停止はユーザーの操作に委ねる */
export function describeDebugStatus(status: DebugServeStatus): string {
  const lines: string[] = [];
  const lease = status.lease;
  if (!lease) {
    lines.push("debug server: none for this conversation");
  } else if (lease.listening) {
    lines.push(`debug server: listening on http://127.0.0.1:${lease.port}/ (started by this conversation)`);
    lines.push(`start command: ${lease.command}`);
    lines.push(`log: ${lease.logPath}`);
  } else {
    lines.push(`debug server: port ${lease.port} was allocated but nothing is listening (the process is gone)`);
    lines.push(`log: ${lease.logPath}`);
  }
  if (status.untrackedPorts.length > 0) {
    lines.push(
      `debug servers started outside this app: ${status.untrackedPorts.join(", ")} (the user can collect them from Settings > Runtime)`,
    );
  }
  return lines.join("\n");
}

/** デバッグ用 serve の停止結果。二重停止も成功として返す (モデルに読み直させない) */
export function describeDebugStop(result: DebugServeStopResult): string {
  if (result.port === null) return "debug server: none for this conversation (already stopped)";
  if (!result.released) return `debug server on port ${result.port}: already stopped (nothing was listening)`;
  return `debug server on port ${result.port}: stopped (port released)`;
}

export interface ServeToolHost {
  /** サンドボックスが設定されているか (未設定ではツールを公開しない) */
  readonly configured: boolean;
  /** 会話 id に束縛した操作。会話 id はモデルから受け取らない */
  run(
    sessionId: string,
    input: {
      action: "start" | "stop" | "status" | "debug_start" | "debug_stop" | "debug_status";
      command?: string;
    },
  ): Promise<string>;
}

/** GUI のルートとエージェントのツールが同じ経路を使うための橋渡し */
export function createServeToolHost(serve: ServeService): ServeToolHost {
  return {
    get configured() {
      return serve.configured;
    },
    async run(sessionId, input) {
      if (input.action === "status") return describeServeStatus(await serve.status(sessionId));
      if (input.action === "debug_status") return describeDebugStatus(await serve.debugStatus(sessionId));
      if (input.action === "debug_start")
        return describeDebugStart(await serve.debugStart(sessionId, { command: input.command }));
      if (input.action === "debug_stop") return describeDebugStop(await serve.debugStop(sessionId));
      // モデルは確認ダイアログを持たないため、実行の直前の世代を読んで同じ再照合を通す。
      // 読んでから実行する間に他会話が入れ替われば 409 になり、モデルは状態を読み直す
      const generation = (await serve.status(sessionId)).generation;
      if (input.action === "stop") return describeServeStatus(await serve.stop(sessionId, { generation }));
      // command を省略したときは、その作業ディレクトリの実績を使う (ServeService が解決する)
      const command = input.command?.trim();
      return describeServeStatus(await serve.start(sessionId, { ...(command ? { command } : {}), generation }));
    },
  };
}

/** SDK の tools へ渡す登録名。serve はサンドボックスが設定されているときだけ足す */
export function withServeTool(base: readonly string[], enabled: boolean): string[] {
  return enabled ? [...base, SERVE_TOOL_NAME] : [...base];
}

export function createServeToolDefinitions(options: {
  enabled: boolean;
  sessionId?: string | undefined;
  host: ServeToolHost;
  /** エージェント定義の組み込みスキル許可リスト。undefined = 全部 ON（既定） */
  builtinSkillNames?: readonly string[] | undefined;
  /** false なら自然文では発火しないので、skill への案内を落とす (既定 true) */
  allowNaturalInvocation?: boolean | undefined;
}): ToolDefinition[] {
  const sessionId = options.sessionId;
  if (!options.enabled || !sessionId) return [];
  const definition: ToolDefinition<typeof serveSchema> = {
    name: SERVE_TOOL_NAME,
    label: SERVE_TOOL_NAME,
    description: serveToolDescription(options.builtinSkillNames, options.allowNaturalInvocation),
    promptSnippet: "Start, stop, or check the app served to the user's browser",
    promptGuidelines: [...SERVE_TOOL_GUIDELINES],
    parameters: serveSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: ServeParams) {
      const text = await options.host.run(sessionId, { action: params.action, command: params.command });
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
  return [definition];
}
