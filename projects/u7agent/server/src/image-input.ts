/**
 * `generate_image` の参照画像（`input_images`）のパス解決と検証。モデル引数の文字列だけを信頼せず、
 * BFF が決めた許可範囲（セッション cwd と、この会話の添付置き場）の中だけを指せるようにする。
 * 出力側の `parseToolPath()` は絶対パスを拒むため流用しない（docs/image-generation.md）。
 */
import { relative, resolve, sep } from "node:path";
import {
  fitsImageInputPixels,
  IMAGE_INPUT_MAX_BYTES,
  IMAGE_INPUT_MIME_TYPES,
  imageDataUrl,
  inspectImageInput,
} from "./image-format";
import { cwdRelativePath, rootRelativeDir } from "./workspace-path";

export interface ImageInputContext {
  /** セッション cwd（root 相対。"" は root） */
  sessionCwd: string;
  /** ワークスペース root の絶対パス */
  rootCwd: string;
  /** この会話の添付置き場（root 相対）。所属スペースで変わる。未確定（子モードなど）は undefined */
  uploadsDirRel: string | undefined;
}

export interface ImageInputTarget {
  /** サンドボックスへ渡す root 相対パス */
  rootRelative: string;
  /** 結果本文に載せる cwd 相対パス */
  display: string;
}

/** エラー文言に載せる要求値。data URL を丸ごと反射しないよう短く切る */
function echoOf(rawPath: string): string {
  const oneLine = rawPath.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function rootRelativeOf(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * 参照画像の要求パスを root 相対へ解決する。cwd 相対と、この会話の cwd / 添付の配下を指す絶対パスだけを受け付け、
 * URL・data URL・`..`・バックスラッシュ・範囲外を拒む。
 */
export function resolveImageInputPath(rawPath: string, context: ImageInputContext): ImageInputTarget {
  const requested = rawPath.trim();
  if (requested === "") throw new Error("input_images のパスが空です");
  if (requested.includes("\\")) {
    throw new Error(`input_images にバックスラッシュは使えません: ${echoOf(requested)}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(requested)) {
    throw new Error(`input_images にはローカル画像のパスだけを指定できます: ${echoOf(requested)}`);
  }
  if (requested.endsWith("/")) {
    throw new Error(`input_images にはファイル名まで指定してください: ${echoOf(requested)}`);
  }
  const segments = requested.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`input_images は作業フォルダの外を参照できません: ${echoOf(requested)}`);
  }
  const rootAbsolute = resolve(context.rootCwd);
  if (requested.startsWith("/")) {
    const absolute = resolve(requested);
    if (!isInside(rootAbsolute, absolute)) {
      throw new Error(`input_images は作業フォルダの外を参照できません: ${echoOf(requested)}`);
    }
    const cwdAbsolute = resolve(rootAbsolute, context.sessionCwd);
    const uploadsAbsolute =
      context.uploadsDirRel === undefined ? undefined : resolve(rootAbsolute, context.uploadsDirRel);
    if (!isInside(cwdAbsolute, absolute) && !(uploadsAbsolute !== undefined && isInside(uploadsAbsolute, absolute))) {
      throw new Error(`input_images は現在の作業フォルダかこの会話の添付だけを参照できます: ${echoOf(requested)}`);
    }
    if (segments.length === 0) throw new Error("input_images のパスが空です");
    return {
      rootRelative: rootRelativeOf(rootAbsolute, absolute),
      display: displayPathOf(rootAbsolute, absolute, context),
    };
  }
  const dir = segments.slice(0, -1).join("/");
  const name = segments.at(-1) ?? "";
  if (name === "") throw new Error("input_images のパスが空です");
  return {
    rootRelative: rootRelativeDir(context.sessionCwd, cwdRelativePath(dir, name)),
    display: cwdRelativePath(dir, name),
  };
}

/** 絶対パスを cwd 相対（添付は root 相対のまま）へ寄せ、結果本文に載せる形にする */
function displayPathOf(rootAbsolute: string, absolute: string, context: ImageInputContext): string {
  const cwdAbsolute = resolve(rootAbsolute, context.sessionCwd);
  if (isInside(cwdAbsolute, absolute)) return rootRelativeOf(cwdAbsolute, absolute);
  return rootRelativeOf(rootAbsolute, absolute);
}

/** サンドボックスへ渡す許可範囲。cwd と添付置き場だけで、モデル引数からは足せない（"" は root） */
export function imageInputScopeOf(context: ImageInputContext): string[] {
  const sources = [context.sessionCwd, ...(context.uploadsDirRel === undefined ? [] : [context.uploadsDirRel])];
  return sources
    .map((dir) =>
      dir
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".")
        .join("/"),
    )
    .filter((dir, index, all) => all.indexOf(dir) === index);
}

/** 受け取ったバイトを provider へ渡す data URL にする。形式・上限の判定はここで完結させる */
export function imageInputReferenceOf(
  bytes: Uint8Array,
  target: ImageInputTarget,
): { mimeType: string; dataUrl: string } {
  if (bytes.byteLength === 0) throw new Error(`参照画像が空です: ${target.display}`);
  if (bytes.byteLength > IMAGE_INPUT_MAX_BYTES) {
    throw new Error(`参照画像が大きすぎます（上限 ${IMAGE_INPUT_MAX_BYTES / (1024 * 1024)} MiB）: ${target.display}`);
  }
  const format = inspectImageInput(bytes);
  if (!format) {
    throw new Error(
      `参照画像として使えるのは ${IMAGE_INPUT_MIME_TYPES.join(" / ")} だけです（実体が画像として読めません）: ${target.display}`,
    );
  }
  if (!fitsImageInputPixels(format.width, format.height)) {
    throw new Error(`参照画像の画素数が上限を超えています: ${target.display}`);
  }
  return {
    mimeType: format.mimeType,
    dataUrl: imageDataUrl(format.mimeType, Buffer.from(bytes).toString("base64")),
  };
}
