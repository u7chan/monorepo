/**
 * BFF ローカルの `serve` ツール。サンドボックスへ送るリモート定義とは別の層で、
 * 起動・停止の実処理は GUI と同じ `ServeService` を共有する (docs/sandbox.md)。
 * 所有者はモデルに申告させず、ツール定義の生成時に渡した会話 id へ束縛する。
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServeStatus } from "./schema";
import type { ServeService } from "./serve";

export const SERVE_TOOL_NAME = "serve";

export const SERVE_TOOL_DESCRIPTION =
  "Start, stop, or check the app served to the user's browser (the UI calls it a service). " +
  "The app must listen on 0.0.0.0:8080. Starting replaces whatever is served now, and the conversation " +
  "that starts it becomes the owner shown in the UI. Follow the bundled `serve` skill for the command and verification loop.";

export const SERVE_TOOL_GUIDELINES = [
  "Use the serve tool instead of starting a background server with bash: only this path records the owner and the start command.",
  "After a start, verify the result with the serve tool (status) and tell the user the URL comes from the UI's service button.",
  "Never put secret values in `command` and never ask the user to paste them into the chat: the user registers environment variables in the Work Environment panel and the app reads them from process.env.",
];

const serveSchema = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")], {
    description:
      "start: run the command and serve it. stop: stop the process listening on 8080. status: read the state",
  }),
  command: Type.Optional(
    Type.String({
      description:
        "start only: the shell command to serve, for example `pnpm dev --host 0.0.0.0 --port 8080 --strictPort`. " +
        "It runs in the conversation's working directory and is recorded as the start command for that directory.",
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

export interface ServeToolHost {
  /** サンドボックスが設定されているか (未設定ではツールを公開しない) */
  readonly configured: boolean;
  /** 会話 id に束縛した操作。会話 id はモデルから受け取らない */
  run(sessionId: string, input: { action: "start" | "stop" | "status"; command?: string }): Promise<string>;
}

/** GUI のルートとエージェントのツールが同じ経路を使うための橋渡し */
export function createServeToolHost(serve: ServeService): ServeToolHost {
  return {
    get configured() {
      return serve.configured;
    },
    async run(sessionId, input) {
      if (input.action === "status") return describeServeStatus(await serve.status(sessionId));
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
}): ToolDefinition[] {
  const sessionId = options.sessionId;
  if (!options.enabled || !sessionId) return [];
  const definition: ToolDefinition<typeof serveSchema> = {
    name: SERVE_TOOL_NAME,
    label: SERVE_TOOL_NAME,
    description: SERVE_TOOL_DESCRIPTION,
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
