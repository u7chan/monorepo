import { createContext, useContext, useMemo, type ReactNode } from "react";
import { resolveFileRef } from "../../lib/fileRef";
import { fileTreeFetchPath } from "../../lib/fileTree";
import { resolveMarkdownAssetPath } from "../../lib/markdownAsset";

/** assistant 本文の画像 src を配信 URL へ解決する。解決できない src は null（本文どおりに描く） */
export type MarkdownImageResolver = (src: string) => string | null;

const MarkdownImageContext = createContext<MarkdownImageResolver | null>(null);

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
      return rawUrl(fileTreeFetchPath(cwd, resolved));
    },
    [rootCwd, cwd, rawUrl],
  );
  return <MarkdownImageContext.Provider value={value}>{children}</MarkdownImageContext.Provider>;
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
      return resolved === null ? null : rawUrl(resolved);
    },
    [dir, rawUrl],
  );
  return <MarkdownImageContext.Provider value={value}>{children}</MarkdownImageContext.Provider>;
}

/** 解決できた src だけを配信 URL へ差し替える。provider の外と解決できない src は入力をそのまま返す */
export function useMarkdownImageSrc(src: string): string {
  const resolve = useContext(MarkdownImageContext);
  if (resolve === null) return src;
  return resolve(src) ?? src;
}
