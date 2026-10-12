import { createContext, useContext, useMemo, type ReactNode } from "react";
import { resolveFileRef } from "../../lib/fileRef";
import { fileTreeFetchPath } from "../../lib/fileTree";
import type { GenerationInfo } from "../../lib/generationInfo";
import { resolveMarkdownAssetPath } from "../../lib/markdownAsset";

/** 解決した画像 src。`src` は配信 URL、`path` は root 相対パス（キャプションの対応付けに使う） */
export type MarkdownImageResolution = { src: string; path: string };

/** assistant 本文の画像 src を配信 URL へ解決する。解決できない src は null（本文どおりに描く） */
export type MarkdownImageResolver = (src: string) => MarkdownImageResolution | null;

const MarkdownImageContext = createContext<MarkdownImageResolver | null>(null);

/** 解決した root 相対パスからキャプションを引く。チャット本文だけが provider を張る（プレビューでは出ない） */
type MarkdownCaptionResolver = (rootRelativePath: string) => GenerationInfo | undefined;

const MarkdownCaptionContext = createContext<MarkdownCaptionResolver | null>(null);

export type MarkdownImageProviderProps = {
  /** ワークスペース root の絶対パス (health.cwd)。未取得 ("") のときは絶対パスを解決しない */
  rootCwd: string;
  /** 選択中セッションの作業フォルダ (payload.cwd)。未確定 ("") のときは何も解決しない */
  cwd: string;
  /**
   * root 相対パスから URL を組み立てる。`client/src/api.ts` は module 評価時に `location.origin` を
   * 読むため、`components/markdown/` からは直接 import せず App が注入する（FileRefProvider と同じ形）。
   */
  rawUrl: (rootRelativePath: string) => string;
  children: ReactNode;
};

/**
 * `![alt](src)` の 3 段解決（cwd 相対 → root 相対 → URL）。外部 URL は resolveFileRef が弾き、
 * provider の外では従来どおり素の img のまま（CSP が外部 URL を止める）。
 */
export function MarkdownImageProvider({ rootCwd, cwd, rawUrl, children }: MarkdownImageProviderProps) {
  const value = useMemo<MarkdownImageResolver>(
    () => (src: string) => {
      const resolved = resolveFileRef(src, rootCwd, cwd);
      if (resolved === null) return null;
      const path = fileTreeFetchPath(cwd, resolved);
      return { src: rawUrl(path), path };
    },
    [rootCwd, cwd, rawUrl],
  );
  return <MarkdownImageContext.Provider value={value}>{children}</MarkdownImageContext.Provider>;
}

/**
 * 生成物のキャプションの対応表。本文の画像があるバブルだけが張る（ファイルプレビューは同じ
 * 画像 provider を共有するが、こちらを張らないためキャプションは出ない）。
 */
export function MarkdownCaptionProvider({
  captions,
  children,
}: {
  /** root 相対パス → そのパスの生成情報。未指定はキャプション無し */
  captions?: Map<string, GenerationInfo>;
  children: ReactNode;
}) {
  const value = useMemo<MarkdownCaptionResolver>(() => (path: string) => captions?.get(path), [captions]);
  return <MarkdownCaptionContext.Provider value={value}>{children}</MarkdownCaptionContext.Provider>;
}

export type MarkdownFileImageProviderProps = {
  /** 表示中のファイルのディレクトリ (ワークスペース root 相対。`"."` は root) */
  dir: string;
  /** 解決した root 相対パスから配信 URL を組み立てる。`client/src/api.ts` を markdown 層から import しないため注入する */
  rawUrl: (rootRelativePath: string) => string;
  children: ReactNode;
};

/**
 * ファイルプレビューの Markdown 画像。チャット本文の cwd 基準の解決を、表示中のファイルの
 * ディレクトリ基準 (`../` はワークスペース root で止める) へ差し替える。
 */
export function MarkdownFileImageProvider({ dir, rawUrl, children }: MarkdownFileImageProviderProps) {
  const value = useMemo<MarkdownImageResolver>(
    () => (src: string) => {
      const resolved = resolveMarkdownAssetPath(src, dir);
      return resolved === null ? null : { src: rawUrl(resolved), path: resolved };
    },
    [dir, rawUrl],
  );
  return <MarkdownImageContext.Provider value={value}>{children}</MarkdownImageContext.Provider>;
}

/** 解決できた src だけを配信 URL へ差し替える。provider の外と解決できない src は入力をそのまま返す */
export function useMarkdownImageSrc(src: string): string {
  return useMarkdownImageResolution(src)?.src ?? src;
}

/** 画像 src の解決結果。provider の外と空の src は null (1 回の解決で URL と root 相対パスの両方を返す) */
export function useMarkdownImageResolution(src: string): MarkdownImageResolution | null {
  const resolve = useContext(MarkdownImageContext);
  if (resolve === null || src === "") return null;
  return resolve(src);
}

/** 解決済みの root 相対パスからキャプションを引く。provider の外と未解決のパスは undefined */
export function useMarkdownImageCaption(path: string | null): GenerationInfo | undefined {
  const resolve = useContext(MarkdownCaptionContext);
  if (resolve === null || path === null) return undefined;
  return resolve(path);
}
