/**
 * セッションで使えるスキルの一覧と `/skill:` の展開。SDK の `_expandSkillCommand` は BFF プロセスの
 * `readFileSync` で本文を読むため、Docker (BFF に作業領域が無い) ではファイル / 組み込みの
 * どちらも展開できない。そこで**アプリ側**で本文を取り直してから `prompt()` へ渡す。
 *
 * 一覧と展開は同じ解決 (project > user > builtin) を共有する。名前だけで選ぶため、
 * 同名の下位スコープは展開対象にならず、一覧では shadowed / shadowedBy として見せる。
 * 本文の取得元はスコープごとに違う (ファイル = サンドボックスの preview、組み込み = registry)。
 * スキルの現行定義はファイルと組み込みだけであり、本文は送信時点のものを読む。
 */
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { builtinSkillByName, builtinSkillEntries } from "./builtin-skills";
import { composeFileSkills, discoverSessionFileSkills, projectSkillsDir, type ComposedFileSkills } from "./file-skills";
import { httpError, messageFor } from "./http";
import { SandboxRequestError, type SandboxToolClient } from "./sandbox/client";
import type { SessionSkillInfo } from "./schema";

/** `/skill:` の接頭辞。SDK の `_expandSkillCommand` と同じく**先頭のみ**を見る */
export const SKILL_COMMAND_PREFIX = "/skill:";

/** スキルの解決に必要なサンドボックスの操作だけ。workspace client でも tool client でも受けられる */
export type SessionSkillsSandbox = Pick<SandboxToolClient, "listSkills" | "previewFile">;

export interface SessionSkillsInput {
  rootCwd: string;
  /** セッションの作業ディレクトリ (root 相対)。プロジェクトスキルの起点 */
  relativeCwd: string;
  /** サンドボックス未設定のときは undefined。ファイルスキルを落として組み込みだけで解決する */
  client?: SessionSkillsSandbox | undefined;
  /**
   * 共通スキルの許可リスト (エージェント定義の `commonSkillNames`)。undefined = 全可視、`[]` = すべて OFF。
   * 一覧と `/skill:` の展開で同じ値を渡す (片方だけだと「ピッカーに残るのに発動しない」になる)。
   */
  commonSkillNames?: readonly string[] | undefined;
  /**
   * 組み込みスキルの許可リスト (エージェント定義の `builtinSkillNames`)。undefined = 全部 ON、`[]` = すべて OFF。
   * commonSkillNames と同じく、一覧と `/skill:` の展開で同じ値を渡す。
   */
  builtinSkillNames?: readonly string[] | undefined;
  /**
   * false なら組み込みスキルを `/skill:` とスキルボタンからのみ起動する。一覧と `/skill:` の展開で
   * 同じ値を渡す (既定 true)。ファイルスキル側とは独立
   */
  allowNaturalInvocationBuiltin?: boolean | undefined;
  /**
   * false ならファイルスキル (共通 / プロジェクト) を `/skill:` とスキルボタンからのみ起動する。
   * 組み込み側とは独立で、どちらのフラグでも `/skill:` の展開は残る
   */
  allowNaturalInvocationFile?: boolean | undefined;
  /**
   * true ならファイルスキルの発見失敗を投げる (一覧 API 用)。既定は落として組み込みだけで解決する
   * (セッション作成と `/skill:` の展開は縮退させる)。
   */
  strict?: boolean | undefined;
}

/** 本文の取得方法。一覧では使わず、展開のときにだけ解決する */
type SkillBodySource = { kind: "file"; path: string } | { kind: "builtin"; name: string };

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
 * SDK の `_expandSkillCommand` と同じ形のブロックを組み立てる。`baseDir` を渡されたときだけ
 * 「References are relative to …」を入れる (呼び出し側はファイル / 組み込みとも実体の場所を渡す)。
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
 * 一覧と展開が共有する解決。ファイルスキル (project > user > builtin) を一意化する。
 * 同名の下位スコープは行としては残し、shadowed / shadowedBy を立てる。
 */
export async function resolveSessionSkills(input: SessionSkillsInput): Promise<ResolvedSessionSkill[]> {
  const composed: ComposedFileSkills = input.client
    ? await discoverSessionFileSkills(input.client, {
        rootCwd: input.rootCwd,
        relativeCwd: input.relativeCwd,
        ...(input.commonSkillNames === undefined ? {} : { commonSkillNames: input.commonSkillNames }),
        ...(input.builtinSkillNames === undefined ? {} : { builtinSkillNames: input.builtinSkillNames }),
        ...(input.allowNaturalInvocationBuiltin === undefined
          ? {}
          : { allowNaturalInvocationBuiltin: input.allowNaturalInvocationBuiltin }),
        ...(input.allowNaturalInvocationFile === undefined
          ? {}
          : { allowNaturalInvocationFile: input.allowNaturalInvocationFile }),
        ...(input.strict === undefined ? {} : { strict: input.strict }),
      })
    : // サンドボックスが無くても組み込みはワークスペースに依らず使える (一覧と展開を同じ解決に保つ)
      composeFileSkills([{ scope: "builtin", entries: builtinSkillEntries(input.rootCwd) }], input.rootCwd, {
        ...(input.builtinSkillNames === undefined ? {} : { builtinSkillNames: input.builtinSkillNames }),
        ...(input.allowNaturalInvocationBuiltin === undefined
          ? {}
          : { allowNaturalInvocationBuiltin: input.allowNaturalInvocationBuiltin }),
      });
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
    // ファイル / 組み込みとも実体のある場所を示す (組み込みは仮想パスだが、案内の基準は同じ)
    baseDir: dirname(skill.info.location),
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
 * 本文が取れない理由を切り分けて返す。削除 (404) と「テキストとして読めない / 2 MiB 超」(400) は
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
