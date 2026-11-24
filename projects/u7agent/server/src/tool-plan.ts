/**
 * セッションへ公開するツール名の計画。エージェント定義の許可リストとアプリ側の実効の積をここ 1 箇所で取り、
 * `tools` の登録名と customTools の有効判定へ同じ結果を渡す。
 */
import { ASK_USER_TOOL_NAME, withAskUserTool } from "./ask-user-tool";
import { BGM_TOOL_NAME } from "./bgm-tools";
import { IMAGE_TOOL_NAME, sessionToolNames } from "./image-tools";
import { INVESTIGATE_TOOL_NAME, withInvestigateTool } from "./investigate-tool";
import { REQUEST_NETWORK_ACCESS_TOOL_NAME, withRequestNetworkAccessTool } from "./request-network-access-tool";
import { SERVE_TOOL_NAME, withServeTool } from "./serve-tool";
import { SPEECH_TOOL_NAME } from "./speech-tools";
import { toolCatalog, type ToolAvailability } from "./tool-catalog";
import { WEB_SEARCH_TOOL_NAME, withWebSearchTool } from "./web-search-tool";

const DEFAULT_TOOLS =
  process.platform === "win32"
    ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls"];

export function configuredTools(): string[] {
  const value = process.env.PI_AGENT_TOOLS?.trim();
  if (!value) return DEFAULT_TOOLS;
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : DEFAULT_TOOLS;
}

/** 子 (investigation モード) へ渡してよいツール。読み取り専用で、project のファイルを変えない */
export const INVESTIGATION_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** 子の allowlist。`PI_AGENT_TOOLS` で絞られている運用では子にも入らない (積を取る) */
export function investigationTools(base: readonly string[]): string[] {
  return INVESTIGATION_TOOLS.filter((tool) => base.includes(tool));
}

/** BFF ローカルのアプリのツール。レジストリの並びとは独立で、ここでは公開の判定にだけ使う */
const APP_TOOL_NAMES = [
  WEB_SEARCH_TOOL_NAME,
  IMAGE_TOOL_NAME,
  SPEECH_TOOL_NAME,
  BGM_TOOL_NAME,
  SERVE_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  REQUEST_NETWORK_ACCESS_TOOL_NAME,
  INVESTIGATE_TOOL_NAME,
] as const;

export interface SessionToolPlan {
  /** 許可リストを通した作業ツール (`createRemoteToolDefinitions` へ渡す集合) */
  sandbox: string[];
  /** SDK の `tools` へ渡す登録名 */
  names: string[];
  /** customTools を組むときの enabled。`names` と同じ判定から作る (片方だけに当てると食い違う) */
  enabled: ReadonlySet<string>;
}

/**
 * セッションへ公開するツールの実効。エージェント定義の許可リスト (undefined = 全部 ON、`[]` = すべて OFF) と
 * アプリ側の実効 (レジストリの可否) の積をここ 1 箇所で取り、`tools` の名前と customTools の enabled へ
 * 同じ結果を渡す。作業ツールはレジストリで引かない: `PI_AGENT_TOOLS` の設定ミスは
 * `createRemoteToolDefinitions` の `UnknownRemoteToolError` で検出する既存の規則を残すため (積でしか効かない)。
 * 子は作業ツールだけを引き継ぎ、アプリのツールは公開しない。
 */
export function sessionToolPlan(input: {
  base: readonly string[];
  toolNames?: readonly string[] | undefined;
  availability: ToolAvailability;
  investigation: boolean;
}): SessionToolPlan {
  const allowed = (name: string) => input.toolNames === undefined || input.toolNames.includes(name);
  const available = new Set(
    toolCatalog(input.availability)
      .filter((tool) => tool.available)
      .map((tool) => tool.name),
  );
  const open = (name: string) => allowed(name) && available.has(name);
  const enabled = new Set<string>(APP_TOOL_NAMES.filter(open));
  const sandbox = input.base.filter(allowed);
  if (input.investigation) return { sandbox, names: sandbox, enabled: new Set() };
  return {
    sandbox,
    enabled,
    names: withInvestigateTool(
      withRequestNetworkAccessTool(
        withAskUserTool(
          withWebSearchTool(
            withServeTool(
              sessionToolNames(sandbox, {
                image: enabled.has(IMAGE_TOOL_NAME),
                speech: enabled.has(SPEECH_TOOL_NAME),
                bgm: enabled.has(BGM_TOOL_NAME),
              }),
              enabled.has(SERVE_TOOL_NAME),
            ),
            enabled.has(WEB_SEARCH_TOOL_NAME),
          ),
          enabled.has(ASK_USER_TOOL_NAME),
        ),
        enabled.has(REQUEST_NETWORK_ACCESS_TOOL_NAME),
      ),
      enabled.has(INVESTIGATE_TOOL_NAME),
    ),
  };
}
