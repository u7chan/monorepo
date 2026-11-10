/**
 * バックアップ ZIP の形式 (manifest / prompts / agents / skills.zip) の読み書きと検証。
 * 外側の ZIP だけをここで解釈し、`skills.zip` の中身はサンドボックスの既存の取り込み経路へ渡す
 * (BFF がスキルの構造を解釈し直さない)。理由は docs/backup.md を参照する。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpError } from "../http";
import {
  AGENT_ORDER_IDS_MAX,
  AGENT_PROMPT_LIMIT,
  BACKUP_AGENTS_FILE_ENTRY,
  BACKUP_APP,
  BACKUP_JSON_MAX_BYTES,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_PROMPTS_FILE_ENTRY,
  BACKUP_SCHEMA_VERSION,
  BACKUP_SKILLS_ENTRY,
  PROMPT_ID_MAX,
  PROMPT_LABEL_MAX,
  PROMPT_ORDER_IDS_MAX,
  PROMPT_TEXT_MAX,
  BackupAgentsFileSchema,
  BackupManifestSchema,
  BackupPromptsFileSchema,
  type BackupAgent,
  type BackupManifest,
  type BackupPrompt,
  type BackupTarget,
} from "../schema";
import { BUILTIN_AGENT_ID, BUILTIN_PROMPTS } from "../builtin-catalog";
import { SANDBOX_MAX_UPLOAD_BYTES } from "../sandbox/protocol";
import { extractZipEntry, readZipArchive, type ZipReadEntry } from "../sandbox/zip-read";

/** 内側のスキル ZIP の上限 (SANDBOX_MAX_UPLOAD_BYTES) に JSON と ZIP のヘッダ分を足した外側の上限 */
export const BACKUP_MAX_BYTES = SANDBOX_MAX_UPLOAD_BYTES + BACKUP_JSON_MAX_BYTES + 64 * 1024;

/** バンドルに入れられるユーザー定義エージェント / 自作プロンプトの上限 (並べ替え API と同じ値) */
export const BACKUP_MAX_AGENTS = AGENT_ORDER_IDS_MAX;
export const BACKUP_MAX_PROMPTS = PROMPT_ORDER_IDS_MAX;

/** 外側のエントリ数の上限。余分なエントリは 400 で断るため、上限はその判定より十分大きく取る */
const BACKUP_MAX_ENTRIES = 16;

/** エージェント ID の長さの上限。プロンプト ID は API と同じ `PROMPT_ID_MAX` で見る */
const BACKUP_AGENT_ID_MAX = 200;

const BUILTIN_PROMPT_IDS = new Set(BUILTIN_PROMPTS.map((entry) => entry.id));

function invalid(message: string): Error {
  return httpError(400, message);
}

export interface ParsedBackup {
  manifest: BackupManifest;
  prompts: BackupPrompt[];
  agents: BackupAgent[];
  /** 展開した `skills.zip` の絶対パス。対象に含まれないときは null */
  skillsZip: string | null;
  /** 復元で実際に置き換える対象 (manifest と query の積) */
  selected: BackupTarget[];
}

/** バンドルに入り得るトップレベルのエントリ名 */
const ENTRY_BY_TARGET: Record<BackupTarget, string> = {
  prompts: BACKUP_PROMPTS_FILE_ENTRY,
  agents: BACKUP_AGENTS_FILE_ENTRY,
  skills: BACKUP_SKILLS_ENTRY,
};

function normalizeId(value: string, name: string, max: number): string {
  const id = value.trim();
  if (!id) throw invalid(`${name} id must not be empty`);
  if (id.length > max) throw invalid(`${name} id must be at most ${max} characters`);
  if (id !== value) throw invalid(`${name} id must not have surrounding whitespace`);
  return id;
}

/** 組み込み ID は「定義としての混入」だけを拒否する (参照は許可する) */
function validatePromptEntry(entry: BackupPrompt): BackupPrompt {
  const id = normalizeId(entry.id, "Prompt", PROMPT_ID_MAX);
  if (BUILTIN_PROMPT_IDS.has(id)) throw invalid(`Built-in prompt cannot be part of a backup: ${id}`);
  const label = entry.label.trim();
  if (!label) throw invalid(`Prompt label is required: ${id}`);
  if (label.length > PROMPT_LABEL_MAX) throw invalid(`Prompt label must be at most ${PROMPT_LABEL_MAX} characters`);
  const prompt = entry.prompt.trim();
  if (!prompt) throw invalid(`Prompt text is required: ${id}`);
  if (prompt.length > PROMPT_TEXT_MAX) throw invalid(`Prompt text must be at most ${PROMPT_TEXT_MAX} characters`);
  return { id, label, prompt };
}

function validateAgentEntry(entry: BackupAgent): BackupAgent {
  const id = normalizeId(entry.id, "Agent", BACKUP_AGENT_ID_MAX);
  if (id === BUILTIN_AGENT_ID) throw invalid(`Built-in agent cannot be part of a backup: ${id}`);
  if (!entry.name.trim()) throw invalid(`Agent name is required: ${id}`);
  const promptIds = entry.promptIds ?? [];
  if (promptIds.length > AGENT_PROMPT_LIMIT) {
    throw invalid(`An agent can reference at most ${AGENT_PROMPT_LIMIT} prompts: ${id}`);
  }
  for (const promptId of promptIds) normalizeId(promptId, "Prompt", PROMPT_ID_MAX);
  return entry;
}

function assertUniqueIds(ids: readonly string[], name: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw invalid(`Duplicate ${name} id: ${id}`);
    seen.add(id);
  }
}

/** 対象の絞り込み。省略は manifest の全対象で、manifest の部分集合だけを許可する */
export function selectTargets(manifest: BackupManifest, requested: readonly string[] | undefined): BackupTarget[] {
  const known = new Set<string>(manifest.targets);
  const selected: BackupTarget[] = [];
  for (const value of requested ?? manifest.targets) {
    if (!known.has(value)) throw invalid(`Unknown backup target: ${value}`);
    if (!selected.includes(value as BackupTarget)) selected.push(value as BackupTarget);
  }
  return selected;
}

/** query の `targets` を manifest と突き合わせる前に、manifest の重複と空を弾く */
function validateManifestTargets(manifest: BackupManifest): void {
  if (manifest.targets.length === 0) throw invalid("Backup manifest has no targets");
  assertUniqueIds(manifest.targets, "target");
}

export interface ReadBackupOptions {
  /** 展開先 (private dir)。呼び出し側が作って消す */
  dir: string;
  /** query の `targets`。省略は manifest の全対象 */
  targets: readonly string[] | undefined;
}

/**
 * 受信した ZIP を読み、manifest と各 JSON、`skills.zip` を展開する。形式の検証 (署名・CRC・サイズ) は
 * `readZipArchive` / `extractZipEntry` に任せ、ここはバンドルの契約 (エントリの一致・スキーマ・件数・ID)
 * だけを見る。
 */
export async function readBackup(path: string, options: ReadBackupOptions): Promise<ParsedBackup> {
  const archive = await readZipArchive(path, { maxBytes: BACKUP_MAX_BYTES, maxEntries: BACKUP_MAX_ENTRIES });
  const known = new Set<string>([BACKUP_MANIFEST_ENTRY, ...Object.values(ENTRY_BY_TARGET)]);
  const entries = new Map<string, ZipReadEntry>();
  for (const entry of archive.entries) {
    if (entry.isDirectory || !known.has(entry.name)) {
      throw invalid(`Unexpected backup entry: ${entry.name}`);
    }
    if (entries.has(entry.name)) throw invalid(`Duplicate backup entry: ${entry.name}`);
    entries.set(entry.name, entry);
  }
  const manifestEntry = entries.get(BACKUP_MANIFEST_ENTRY);
  if (!manifestEntry) throw invalid("Backup manifest is missing");

  // JSON の上限は 3 本の合計で見る (1 本ずつ 16 MiB を通すと合計 48 MiB まで展開でき、
  // `BACKUP_MAX_BYTES` の見積りと合わなくなる)
  let jsonBytes = 0;
  const readJson = async (entry: ZipReadEntry): Promise<unknown> => {
    jsonBytes += entry.size;
    if (jsonBytes > BACKUP_JSON_MAX_BYTES) {
      throw invalid(`Backup JSON is too large (max ${BACKUP_JSON_MAX_BYTES} bytes)`);
    }
    const target = join(options.dir, entry.name);
    await extractZipEntry({ archive: path, entry, target, dataLimit: archive.dataLimit });
    const text = await readFile(target, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalid(`Backup entry is not valid JSON: ${entry.name}`);
    }
  };

  const manifestValue = await readJson(manifestEntry);
  const parsedManifest = BackupManifestSchema.safeParse(manifestValue);
  if (!parsedManifest.success) throw invalid("Backup manifest is invalid");
  const manifest = parsedManifest.data;
  if (manifest.app !== BACKUP_APP) throw invalid(`Unsupported backup app: ${manifest.app}`);
  if (manifest.schema !== BACKUP_SCHEMA_VERSION) {
    throw invalid(`Unsupported backup schema: ${manifest.schema}`);
  }
  validateManifestTargets(manifest);
  const selected = selectTargets(manifest, options.targets);

  // manifest.targets と実エントリを完全一致にする (余分・欠落のどちらも受け付けない)
  const expected = new Set<string>([
    BACKUP_MANIFEST_ENTRY,
    ...manifest.targets.map((target) => ENTRY_BY_TARGET[target]),
  ]);
  for (const name of expected) {
    if (!entries.has(name)) throw invalid(`Backup entry is missing: ${name}`);
  }
  for (const name of entries.keys()) {
    if (!expected.has(name)) throw invalid(`Unexpected backup entry: ${name}`);
  }

  const readTargetJson = async (target: BackupTarget): Promise<unknown> => {
    const entry = entries.get(ENTRY_BY_TARGET[target]);
    if (!entry) throw invalid(`Backup entry is missing: ${ENTRY_BY_TARGET[target]}`);
    return readJson(entry);
  };

  let prompts: BackupPrompt[] = [];
  if (manifest.targets.includes("prompts")) {
    const parsed = BackupPromptsFileSchema.safeParse(await readTargetJson("prompts"));
    if (!parsed.success) throw invalid("Backup prompts are invalid");
    if (parsed.data.prompts.length > BACKUP_MAX_PROMPTS) {
      throw invalid(`Backup has too many prompts (max ${BACKUP_MAX_PROMPTS})`);
    }
    prompts = parsed.data.prompts.map(validatePromptEntry);
    assertUniqueIds(
      prompts.map((entry) => entry.id),
      "prompt",
    );
  }

  let agents: BackupAgent[] = [];
  if (manifest.targets.includes("agents")) {
    const parsed = BackupAgentsFileSchema.safeParse(await readTargetJson("agents"));
    if (!parsed.success) throw invalid("Backup agents are invalid");
    if (parsed.data.agents.length > BACKUP_MAX_AGENTS) {
      throw invalid(`Backup has too many agents (max ${BACKUP_MAX_AGENTS})`);
    }
    agents = parsed.data.agents.map(validateAgentEntry);
    assertUniqueIds(
      agents.map((entry) => entry.id),
      "agent",
    );
  }

  let skillsZip: string | null = null;
  if (manifest.targets.includes("skills")) {
    const entry = entries.get(BACKUP_SKILLS_ENTRY);
    if (!entry) throw invalid(`Backup entry is missing: ${BACKUP_SKILLS_ENTRY}`);
    if (entry.size > SANDBOX_MAX_UPLOAD_BYTES) {
      throw invalid(`Backup entry is too large: ${BACKUP_SKILLS_ENTRY}`);
    }
    skillsZip = join(options.dir, BACKUP_SKILLS_ENTRY);
    await extractZipEntry({ archive: path, entry, target: skillsZip, dataLimit: archive.dataLimit });
  }

  return { manifest, prompts, agents, skillsZip, selected };
}
