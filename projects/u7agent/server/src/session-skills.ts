/**
 * セッションで使えるスキルの一覧と `/skill:` の展開。SDK の `_expandSkillCommand` は BFF プロセスの
 * `readFileSync` で本文を読むため、Docker (BFF に作業領域が無い) ではファイル / 組み込みのどちらも
 * 展開できない。そこで**アプリ側**で本文を取り直してから `prompt()` へ渡す。
 *
 * 一覧と展開は同じ解決 (project > user > builtin > catalog) を共有する。名前だけで選ぶため、
 * 同名の下位スコープは展開対象にならず、一覧では shadowed / shadowedBy として見せる。
 * 本文の取得元はスコープごとに違う (ファイル = サンドボックスの preview、組み込み = registry、
 * カタログ = セッションの promptSnapshot)。固定されるのは一覧・説明・優先順位だけで、本文は送信時点。
 */
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { builtinSkillByName, builtinSkillEntries } from "./builtin-skills";
import { composeFileSkills, discoverSessionFileSkills, projectSkillsDir, type ComposedFileSkills } from "./file-skills";
import { httpError, messageFor } from "./http";
import { SandboxRequestError, type SandboxToolClient } from "./sandbox/client";
import type { AgentSkillInfo, SessionSkillInfo } from "./schema";
import type { PromptSnapshot } from "./session-store";

/** `/skill:` の接頭辞。SDK の `_expandSkillCommand` と同じく**先頭のみ**を見る */
export const SKILL_COMMAND_PREFIX = "/skill:";
/** カタログ (Agent 割り当て) スキルの location。実ファイルが無いため名前空間を指す仮想の値にする */
export const CATALOG_SKILL_LOCATION_PREFIX = "catalog:";

/** カタログスキルの location (実ファイルが無いので read できない) */
export function catalogSkillLocation(name: string): string {
  return `${CATALOG_SKILL_LOCATION_PREFIX}${name}`;
}

/** スキルの解決に必要なサンドボックスの操作だけ。workspace client でも tool client でも受けられる */
export type SessionSkillsSandbox = Pick<SandboxToolClient, "listSkills" | "previewFile">;

export interface SessionSkillsInput {
  rootCwd: string;
  /** セッションの作業ディレクトリ (root 相対)。プロジェクトスキルの起点 */
  relativeCwd: string;
  /** サンドボックス未設定のときは undefined。ファイルスキルを落として組み込み / カタログだけで解決する */
  client?: SessionSkillsSandbox | undefined;
  /** セッションのプロンプトスナップショット。カタログスキルの本文の出所 (実ファイルが無い) */
  promptSnapshot?: PromptSnapshot | undefined;
  /** セッションのエージェントスナップショット。カタログスキルの説明の出所 */
  agentSkills?: AgentSkillInfo[] | undefined;
  /**
   * true ならファイルスキルの発見失敗を投げる (一覧 API 用)。既定は落として組み込み / カタログだけで解決する
   * (セッション作成と `/skill:` の展開は縮退させる)。
   */
  strict?: boolean | undefined;
}

/** 本文の取得方法。一覧では使わず、展開のときにだけ解決する */
type SkillBodySource =
  | { kind: "file"; path: string }
  | { kind: "builtin"; name: string }
  | { kind: "catalog"; name: string };

export interface ResolvedSessionSkill {
  info: SessionSkillInfo;
  body: SkillBodySource;
}

/** `/skill:name args` の解釈。SDK と同じく接頭辞と最初の空白だけで切る (引数は trim する) */
export function parseSkillCommand(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name =
    spaceIndex === -1 ? text.slice(SKILL_COMMAND_PREFIX.length) : text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex);
  if (!name) return undefined;
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  return { name, args };
}

/**
 * SDK の `_expandSkillCommand` と同じ形のブロックを組み立てる。`baseDir` がある (ファイル / 組み込み) ときだけ
 * 「References are relative to …」を入れる。カタログはファイルが無いので入れない。
 */
export function formatSkillCommandBlock(input: {
  name: string;
  location: string;
  body: string;
  args?: string;
  baseDir?: string | undefined;
}): string {
  const references = input.baseDir ? `References are relative to ${input.baseDir}.\n\n` : "";
  const block = `<skill name="${input.name}" location="${input.location}">\n${references}${input.body}\n</skill>`;
  return input.args ? `${block}\n\n${input.args}` : block;
}

/**
 * promptSnapshot の 1 件 (`<agent_skill name="…">本文</agent_skill>`) を name と本文に分ける。
 * タグ名ではなく name 属性で引くため、旧 `<skill>` と新 `<agent_skill>` の両方を受ける。
 */
export function parseCatalogSkillBlock(block: string): { name: string; body: string } | undefined {
  const open = block.match(/^<(?:agent_skill|skill) name="([^"]+)">\n/);
  if (!open) return undefined;
  let body = block.slice(open[0].length);
  const close = body.match(/\n<\/(?:agent_skill|skill)>$/);
  if (close) body = body.slice(0, close.index);
  return { name: open[1] as string, body };
}

/** promptSnapshot からカタログスキルを取り出す (順序は保存順のまま) */
export function catalogSkillsFromSnapshot(snapshot?: PromptSnapshot): Array<{ name: string; body: string }> {
  const blocks = snapshot?.skills ?? [];
  return blocks
    .map((block) => parseCatalogSkillBlock(block))
    .filter((skill): skill is { name: string; body: string } => skill !== undefined);
}

/**
 * 一覧と展開が共有する解決。ファイルスキル (project > user > builtin) を先に一意化し、その後に
 * カタログ (最低優先) を足す。同名の下位スコープは行としては残し、shadowed / shadowedBy を立てる。
 */
export async function resolveSessionSkills(input: SessionSkillsInput): Promise<ResolvedSessionSkill[]> {
  const composed: ComposedFileSkills = input.client
    ? await discoverSessionFileSkills(input.client, {
        rootCwd: input.rootCwd,
        relativeCwd: input.relativeCwd,
        ...(input.strict === undefined ? {} : { strict: input.strict }),
      })
    : // サンドボックスが無くても組み込みはワークスペースに依らず使える (一覧と展開を同じ解決に保つ)
      composeFileSkills([{ scope: "builtin", entries: builtinSkillEntries(input.rootCwd) }], input.rootCwd);
  // 影になった組み合わせは「落ちた側のパス → 採用された側のパス」で引く
  const keptByShadowed = new Map(composed.shadowed.map((item) => [item.shadowedPath, item.keptPath]));
  // 採用された行が隠している側 (ファイル同士の重複は行として残らないので、ここで持ち回る)
  const shadowsByKept = new Map<string, string[]>();
  for (const item of composed.shadowed) {
    const list = shadowsByKept.get(item.keptPath);
    if (list) list.push(item.shadowedPath);
    else shadowsByKept.set(item.keptPath, [item.shadowedPath]);
  }

  const resolved: ResolvedSessionSkill[] = [];
  const winnerByName = new Map<string, SessionSkillInfo>();

  for (const row of composed.response.skills) {
    // 組み込みがファイルスキルに上書きされた場合だけ shadowed が立つ (ファイル同士の敗者は行にならない)
    const shadowedBy = row.overridden ? (keptByShadowed.get(row.path) ?? null) : null;
    const body: SkillBodySource =
      row.scope === "builtin" ? { kind: "builtin", name: row.name } : { kind: "file", path: row.path };
    const info: SessionSkillInfo = {
      name: row.name,
      description: row.description,
      scope: row.scope,
      location: row.path,
      relativePath: row.relativePath,
      disableModelInvocation: row.disableModelInvocation,
      shadowed: shadowedBy !== null,
      shadowedBy,
      // 採用された行が隠している側 (ファイル同士の重複は行として残らないので、ここで見せる)
      shadows: shadowsByKept.get(row.path) ?? [],
    };
    resolved.push({ info, body });
    if (!info.shadowed) winnerByName.set(info.name, info);
  }

  const descriptions = new Map((input.agentSkills ?? []).map((skill) => [skill.name, skill.description]));
  for (const skill of catalogSkillsFromSnapshot(input.promptSnapshot)) {
    const winner = winnerByName.get(skill.name);
    const info: SessionSkillInfo = {
      name: skill.name,
      // 説明はセッションのエージェントスナップショットから引く (snapshot の本文には説明が無い)
      description: descriptions.get(skill.name) ?? "",
      scope: "catalog",
      location: catalogSkillLocation(skill.name),
      relativePath: null,
      // カタログのスキルは system prompt に載るだけで、モデルからの起動可否は持たない
      disableModelInvocation: false,
      shadowed: winner !== undefined,
      shadowedBy: winner?.location ?? null,
      // カタログは最低優先なので、隠す側にはならない
      shadows: [],
    };
    resolved.push({ info, body: { kind: "catalog", name: skill.name } });
    if (!info.shadowed) winnerByName.set(info.name, info);
  }

  return resolved;
}

/** GET /api/sessions/:id/skills の応答に載せる形 (本文の取得方法は落とす) */
export async function listSessionSkills(input: SessionSkillsInput): Promise<SessionSkillInfo[]> {
  return (await resolveSessionSkills(input)).map((item) => item.info);
}

/**
 * 送信経路で `/skill:` を本文ブロックへ置換する。未知の名前・接頭辞なしは素通し (SDK と同じ挙動)。
 * 本文が取れないときだけ 4xx / 502 で止める (切り詰めて黙って送ると、モデルが読んだ本文が変わる)。
 */
export async function expandSkillCommand(text: string, input: SessionSkillsInput): Promise<string> {
  const command = parseSkillCommand(text);
  if (!command) return text;
  const resolved = await resolveSessionSkills(input);
  const skill = resolved.find((item) => item.info.name === command.name && !item.info.shadowed);
  if (!skill) return text;
  const body = await resolveSkillBody(skill, input);
  return formatSkillCommandBlock({
    name: skill.info.name,
    location: skill.info.location,
    body,
    args: command.args,
    baseDir: skill.body.kind === "catalog" ? undefined : dirname(skill.info.location),
  });
}

/** 本文の取得。ファイルはサンドボックスの preview (frontmatter は SDK と同じく落とす) */
async function resolveSkillBody(skill: ResolvedSessionSkill, input: SessionSkillsInput): Promise<string> {
  const source = skill.body;
  if (source.kind === "builtin") {
    const builtin = builtinSkillByName(source.name);
    if (!builtin) throw httpError(500, `組み込みスキル ${source.name} が見つかりません`);
    return stripFrontmatter(builtin.body).trim();
  }
  if (source.kind === "catalog") {
    const block = catalogSkillsFromSnapshot(input.promptSnapshot).find((item) => item.name === source.name);
    if (!block) throw httpError(500, `スキル ${source.name} の本文がプロンプトスナップショットにありません`);
    return block.body.trim();
  }
  if (!input.client) {
    throw httpError(503, `スキル "${skill.info.name}" の本文を取得できません（サンドボックスが設定されていません）`);
  }
  try {
    const preview = await input.client.previewFile(source.path);
    return stripFrontmatter(preview.text).trim();
  } catch (error) {
    throw skillBodyError(skill.info, error);
  }
}

/**
 * 本文が取れない理由を切り分けて返す。削除 (404) と「テキストとして読めない / 256 KiB 超」(400) は
 * ユーザーが直せるのでサンドボックスの文言をそのまま見せ、それ以外は 502 に寄せる。
 */
function skillBodyError(info: SessionSkillInfo, error: unknown): Error {
  if (error instanceof SandboxRequestError) {
    if (error.status === 404) {
      return httpError(
        404,
        `スキル "${info.name}" の本文が見つかりません（削除された可能性があります）: ${info.location}`,
      );
    }
    if (error.status === 400) {
      return httpError(400, `スキル "${info.name}" の本文を取得できません: ${error.message}`);
    }
    return httpError(502, `スキル "${info.name}" の本文を取得できません: ${error.message}`);
  }
  return httpError(502, `スキル "${info.name}" の本文を取得できません: ${messageFor(error)}`);
}

/** プロジェクトスキルを探索するセッションか (未所属のスクラッチと root 直下は false) */
export function hasProjectSkills(relativeCwd: string): boolean {
  return projectSkillsDir(relativeCwd) !== undefined;
}
