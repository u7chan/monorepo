/**
 * 試行の成果物の置き場。セッションストア / アプリ DB の兄弟 (`<storeDir>/trials`) に
 * `<trialId>.<ext>` だけを置き、`generated/` にもプロジェクトにも DB の BLOB にも置かない。
 * ファイル名は trial id から作り、外から来たパスは fs へ渡さない（契約は docs/api-settings.md）。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectImageInput } from "./image-format";
import { saveableImageFormat, type SaveableImageFormat } from "./images";
import { pcmToWav, type GeneratedSpeech } from "./speech";

/** 会話ストア直下のディレクトリ名。DB (`u7agent.db`) と同じ領域の兄弟に置く */
export const TRIAL_ARTIFACTS_DIR_NAME = "trials";

/**
 * 1 件の上限。provider の応答（`server/src/images.ts` の応答上限）より小さくし、
 * 保存側でも二重に止める（上限を超えたファイルは書かない）。
 */
export const TRIAL_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

/** 保存・配信できる形式。拡張子と配信 MIME はこの一覧に固定する */
export const TRIAL_ARTIFACT_FORMATS = ["png", "jpeg", "webp", "mp3", "wav"] as const;
export type TrialArtifactFormat = (typeof TRIAL_ARTIFACT_FORMATS)[number];

/**
 * 種別ごとに保存・配信できる形式。画像の行に音声、音声の行に画像が入らないよう、配信の判定でも種別を見る。
 * BGM は生成器が MP3 だけを返す（`assertBgmMp3`）ので mp3 だけを通す。
 */
export const TRIAL_ARTIFACT_FORMATS_BY_KIND: Record<string, readonly TrialArtifactFormat[]> = {
  image: ["png", "jpeg", "webp"],
  speech: ["mp3", "wav"],
  bgm: ["mp3"],
};

const EXTENSIONS: Record<TrialArtifactFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  mp3: "mp3",
  wav: "wav",
};

const CONTENT_TYPES: Record<TrialArtifactFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

const TRIAL_ID_PATTERN = /^trial-[0-9a-f]{24}$/;
const ARTIFACT_FILE_PATTERN = /^(trial-[0-9a-f]{24})\.(png|jpg|webp|mp3|wav)$/;

export function isTrialId(value: string): boolean {
  return TRIAL_ID_PATTERN.test(value);
}

/** 保存名。id と形式からだけ作り、呼び出し側の文字列を混ぜない */
export function trialArtifactFileName(trialId: string, format: TrialArtifactFormat): string {
  if (!isTrialId(trialId)) throw new Error("試行 ID が不正です");
  return `${trialId}.${EXTENSIONS[format]}`;
}

/** ファイル名から trial id を引く。再照合で「実行中のジョブのファイル」を除外するために使う */
export function trialArtifactIdOfFileName(fileName: string): string | undefined {
  return ARTIFACT_FILE_PATTERN.exec(fileName)?.[1];
}

/** 保存時に確定した形式だけを配信 MIME にする（拡張子や要求からは決めない） */
export function trialArtifactContentType(format: TrialArtifactFormat): string {
  return CONTENT_TYPES[format];
}

export function trialArtifactFormatOf(value: string): TrialArtifactFormat | undefined {
  return (TRIAL_ARTIFACT_FORMATS as readonly string[]).includes(value) ? (value as TrialArtifactFormat) : undefined;
}

/** その種別の行に保存・配信してよい形式か。種別が未知なら何も通さない */
export function trialArtifactFormatAllowed(kind: string, format: TrialArtifactFormat): boolean {
  const allowed = TRIAL_ARTIFACT_FORMATS_BY_KIND[kind] ?? [];
  return allowed.includes(format);
}

export type TrialArtifactRejectReason = "unsupported_format" | "too_large" | "invalid_bytes";

export type TrialImagePreparation =
  | { ok: true; format: SaveableImageFormat; bytes: Uint8Array; width: number; height: number }
  | { ok: false; reason: TrialArtifactRejectReason };

const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]*$/;

/**
 * 生成応答を保存できる形へ整える。宣言 MIME と実バイトの両方が許可リストに載っていることを確かめ、
 * 実バイトの形式を正にする（宣言だけを信じると、`nosniff` でも宣言と実体のずれたファイルを配信する）。
 * 保存の前にここで止めるため、拒否した応答は 1 バイトもディスクへ書かない。
 */
export function prepareTrialImageArtifact(image: { mimeType: string; data: string }): TrialImagePreparation {
  if (saveableImageFormat(image.mimeType) === undefined) return { ok: false, reason: "unsupported_format" };
  if (!BASE64_PATTERN.test(image.data)) return { ok: false, reason: "invalid_bytes" };
  const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
  if (bytes.byteLength === 0) return { ok: false, reason: "invalid_bytes" };
  if (bytes.byteLength > TRIAL_ARTIFACT_MAX_BYTES) return { ok: false, reason: "too_large" };
  const inspected = inspectImageInput(bytes);
  if (!inspected) return { ok: false, reason: "unsupported_format" };
  const format = saveableImageFormat(inspected.mimeType);
  if (format === undefined) return { ok: false, reason: "unsupported_format" };
  return { ok: true, format, bytes, width: inspected.width, height: inspected.height };
}

export type TrialSpeechPreparation =
  | { ok: true; format: "mp3" | "wav"; bytes: Uint8Array }
  | { ok: false; reason: TrialArtifactRejectReason };

/**
 * 生成した音声を保存できる形へ整える。画像と同じく、宣言 MIME と実バイトの両方が許可リストに載っているかを
 * 確かめ、実バイトの形式を正にする（pcm は生成器の RIFF 化と同じ関数で wav にする）。
 */
export function prepareTrialSpeechArtifact(speech: GeneratedSpeech): TrialSpeechPreparation {
  if (speech.format === "mp3" && speech.contentType !== "audio/mpeg")
    return { ok: false, reason: "unsupported_format" };
  const bytes =
    speech.format === "pcm"
      ? new Uint8Array(pcmToWav(speech.audio, speech.sampleRate, speech.channels))
      : new Uint8Array(speech.audio);
  if (bytes.byteLength > TRIAL_ARTIFACT_MAX_BYTES) return { ok: false, reason: "too_large" };
  const sniffed = sniffAudioFormat(bytes);
  if (sniffed === undefined) return { ok: false, reason: "invalid_bytes" };
  return { ok: true, format: sniffed, bytes };
}

export type TrialBgmPreparation =
  | { ok: true; format: "mp3"; bytes: Uint8Array }
  | { ok: false; reason: TrialArtifactRejectReason };

/**
 * BGM の生成結果（MP3 の実バイト）を保存できる形へ整える。生成器は形式を宣言せずバイトだけを返すため、
 * 宣言 MIME は固定の `audio/mpeg` とし、実バイトが MP3 として読めることを保存の前に確かめる。
 */
export function prepareTrialBgmArtifact(bytes: Uint8Array): TrialBgmPreparation {
  if (bytes.byteLength > TRIAL_ARTIFACT_MAX_BYTES) return { ok: false, reason: "too_large" };
  const sniffed = sniffAudioFormat(bytes);
  if (sniffed === undefined) return { ok: false, reason: "invalid_bytes" };
  // wav は BGM の生成器が返さない形式なので、保存先の許可リストに合わせて拒否する
  if (sniffed !== "mp3") return { ok: false, reason: "unsupported_format" };
  return { ok: true, format: "mp3", bytes };
}

/**
 * 実バイトの形式。wav は RIFF/WAVE、mp3 は ID3 かフレーム同期で見る（宣言だけを信じると、`nosniff` でも
 * 宣言と実体のずれたファイルを配信する）。
 */
function sniffAudioFormat(bytes: Uint8Array): "mp3" | "wav" | undefined {
  const ascii = (offset: number, text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };
  if (bytes.byteLength >= 12 && ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (bytes.byteLength >= 3 && ascii(0, "ID3")) return "mp3";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "mp3";
  return undefined;
}

export interface TrialArtifactStore {
  /** `<trialId>.<ext>` を書く。書けなければ例外（呼び出し側が `storage` 失敗にする） */
  write(input: { trialId: string; format: TrialArtifactFormat; bytes: Uint8Array }): Promise<void>;
  /** 保存名で読む。無ければ undefined。保存名の形を外れる要求は読まない */
  read(fileName: string): Promise<ArrayBuffer | undefined>;
  /** 保存名のファイルが置き場にあるか。reuse の判定は同期の start から呼ぶ */
  exists(fileName: string): boolean;
  /** 保存名で消す。無くても成功として扱う（冪等） */
  remove(fileName: string): Promise<void>;
  /** 置き場のファイル名。ディレクトリが無ければ空 */
  list(): Promise<string[]>;
}

/**
 * 置き場の実装。`dir` は会話ストア直下の `trials` だけで、削除はこのディレクトリの内側に限る
 * （`generated/` には触れない）。名前の検査をここに閉じるため、パスを組み立てる経路は 1 つだけになる。
 */
export function createTrialArtifactStore(dir: string): TrialArtifactStore {
  const pathOf = (fileName: string): string => {
    if (trialArtifactIdOfFileName(fileName) === undefined) throw new Error("成果物の名前が不正です");
    return join(dir, fileName);
  };
  return {
    write: async (input) => {
      await mkdir(dir, { recursive: true });
      await writeFile(pathOf(trialArtifactFileName(input.trialId, input.format)), input.bytes);
    },
    read: async (fileName) => {
      try {
        const buffer = await readFile(pathOf(fileName));
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    exists: (fileName) => existsSync(pathOf(fileName)),
    remove: async (fileName) => {
      await rm(pathOf(fileName), { force: true });
    },
    list: async () => {
      try {
        return (await readdir(dir)).filter((name) => trialArtifactIdOfFileName(name) !== undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
