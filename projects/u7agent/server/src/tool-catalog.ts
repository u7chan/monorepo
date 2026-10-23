/**
 * ツールのレジストリ。名前・説明・種別 (作業 / アプリ) をここ 1 箇所に置き、`GET /api/agents` の応答と
 * 画面の行を同じ定義から組む。モデルへ渡す description / promptGuidelines は各ツール定義
 * (sandbox/remote-tools.ts と *-tool.ts) が正で、ここは利用者に見せる説明だけを持つ。
 *
 * 作業ツールはサンドボックスが提供する一覧 (remote-tools.ts の REMOTE_TOOL_NAMES) と名前を揃える。
 * powershell のようなプラットフォーム差は扱わない (サンドボックスは提供せず、PI_AGENT_TOOLS の設定ミスは
 * createRemoteToolDefinitions が UnknownRemoteToolError で検出する既存の規則を残す)。
 */
import type { ToolCatalogEntry, ToolGroup, ToolUnavailableReason } from "./schema";

/** アプリ側の実効。エージェントの許可リストとの積を取る前に、アプリ自身がツールを公開しているか */
export interface ToolAvailability {
  /** `PI_AGENT_TOOLS` の実効 (agent.ts の `configuredTools()`)。デプロイ側の上限 */
  sandboxTools: readonly string[];
  /** コンテンツ生成の設定が有効か (キー未設定では false) */
  contentGeneration: boolean;
  /** Web 検索の実行時トグル。セッション作成時に読む */
  webSearch: boolean;
  serve: boolean;
  askUser: boolean;
  investigate: boolean;
}

/** アプリ側の可否を引くキー。作業ツールは `sandboxTools` の一覧で決まるため持たない */
type AppGate = Exclude<keyof ToolAvailability, "sandboxTools">;

interface ToolRegistryEntry {
  name: string;
  description: string;
  group: ToolGroup;
  gate?: AppGate;
  /** 止まっている理由。省略は app_disabled で、キー未設定で止まるものだけ no_key にする */
  offReason?: ToolUnavailableReason;
}

const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  { name: "read", description: "ファイルの内容を読む（スキル本文の読み込みも含む）", group: "sandbox" },
  { name: "bash", description: "シェルコマンドを実行する", group: "sandbox" },
  { name: "edit", description: "既存ファイルの一部を置き換える", group: "sandbox" },
  { name: "write", description: "ファイルを作成・上書きする", group: "sandbox" },
  { name: "grep", description: "正規表現でファイルの中身を検索する", group: "sandbox" },
  { name: "find", description: "名前でファイルを探す", group: "sandbox" },
  { name: "ls", description: "ディレクトリの中身を一覧する", group: "sandbox" },
  { name: "web_search", description: "Web を検索して上位ページの抜粋を取る", group: "app", gate: "webSearch" },
  {
    name: "generate_image",
    description: "画像を生成・編集して作業フォルダへ保存する",
    group: "app",
    gate: "contentGeneration",
    offReason: "no_key",
  },
  {
    name: "generate_speech",
    description: "音声を生成して作業フォルダへ保存する",
    group: "app",
    gate: "contentGeneration",
    offReason: "no_key",
  },
  {
    name: "generate_bgm",
    description: "インストゥルメンタルBGMを生成してMP3を作業フォルダへ保存する",
    group: "app",
    gate: "contentGeneration",
    offReason: "no_key",
  },
  {
    name: "serve",
    description: "アプリを起動・確認・停止する（UI 上の呼称は「サービス」）",
    group: "app",
    gate: "serve",
  },
  { name: "ask_user", description: "選択肢つきの質問をユーザーへ出す", group: "app", gate: "askUser" },
  { name: "investigate", description: "調査を子エージェントへ委譲する", group: "app", gate: "investigate" },
];

/** レジストリの全件。`available` は引数時点のアプリ側の実効で、エージェントの許可リストは掛けない */
export function toolCatalog(availability: ToolAvailability): ToolCatalogEntry[] {
  return TOOL_REGISTRY.map((entry) => {
    const base = { name: entry.name, description: entry.description, group: entry.group };
    if (!entry.gate) {
      return availability.sandboxTools.includes(entry.name)
        ? { ...base, available: true }
        : { ...base, available: false, reason: "deploy_allowlist" as const };
    }
    return availability[entry.gate]
      ? { ...base, available: true }
      : { ...base, available: false, reason: entry.offReason ?? ("app_disabled" as const) };
  });
}
