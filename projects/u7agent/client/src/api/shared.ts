import { client, ensureOk, read } from "./http";
import type {
  CreateSharedContentBody,
  SharedContentExclusionsResponse,
  SharedContentMutationResponse,
  SharedContentPreviewResponse,
  SharedContentResponse,
  SharedContentsResponse,
  SharedContentStopResponse,
  SharedContentThumbnailResponse,
} from "../types";

/**
 * この会話の共有物（静的コンテンツ）。会話の絞り込みは共有ダイアログ用で、管理一覧は
 * `getAllSharedContents` を使う。公開は非同期なので、`publishing` の間は状態を読み直す。
 */
export const getSharedContents = async (sessionId: string, signal?: AbortSignal): Promise<SharedContentsResponse> => {
  const res = await ensureOk(client.api["shared-contents"].$get({ query: { sessionId } }, { init: { signal } }));
  return res.json();
};

/** 全共有物の一覧。設定 → 共有 の管理一覧が使う（会話では絞らない） */
export const getAllSharedContents = async (signal?: AbortSignal): Promise<SharedContentsResponse> => {
  const res = await ensureOk(client.api["shared-contents"].$get({}, { init: { signal } }));
  return res.json();
};

/** 1 件の共有物。`publishing` の間のポーリングに使う */
export const getSharedContent = async (id: string, signal?: AbortSignal): Promise<SharedContentResponse> => {
  const res = await ensureOk(client.api["shared-contents"][":id"].$get({ param: { id } }, { init: { signal } }));
  return res.json();
};

/**
 * 公開前のプレビュー。応答の型は hc が AppType から推論するので、ここで DTO を書き起こさない。
 * 補助情報なので、取得できなくても公開の受付はそのまま行う。
 */
export const getSharedContentPreview = async (
  input: { sessionId: string; directory: string },
  signal?: AbortSignal,
): Promise<SharedContentPreviewResponse> => {
  const res = await ensureOk(
    client.api["shared-contents"].preview.$get(
      { query: { sessionId: input.sessionId, directory: input.directory } },
      { init: { signal } },
    ),
  );
  return res.json();
};

/**
 * 共有を開始する。202 が返った時点では公開中で、URL は既に確定している。
 * 受付の失敗（資格情報の未登録など）は BFF の固定文言を `ApiError.message` で返す。
 */
export const createSharedContent = async (input: CreateSharedContentBody): Promise<SharedContentMutationResponse> => {
  const res = await ensureOk(client.api["shared-contents"].$post({ json: input }));
  return res.json();
};

/**
 * 更新と failed からの再試行。現在の `source_path` を読み直して同じ URL へ再公開する（202）。
 * 状態は GET で読み直す。失敗の固定文言は BFF の `error` をそのまま使う。
 */
export const publishSharedContent = async (id: string): Promise<SharedContentMutationResponse> => {
  const res = await ensureOk(client.api["shared-contents"][":id"].publish.$post({ param: { id } }));
  return res.json();
};

/** 停止。provider の結果を待って 200 で確定する（URL と行は残る） */
export const stopSharedContent = async (id: string): Promise<SharedContentStopResponse> => {
  const res = await ensureOk(client.api["shared-contents"][":id"].stop.$post({ param: { id } }));
  return res.json();
};

/** 再公開。停止中の共有物の subdomain を有効に戻す（202、版は変えない） */
export const resumeSharedContent = async (id: string): Promise<SharedContentMutationResponse> => {
  const res = await ensureOk(client.api["shared-contents"][":id"].resume.$post({ param: { id } }));
  return res.json();
};

/** 削除。provider 側の削除が成功してから行が消える（204、本文なし） */
export const deleteSharedContent = async (id: string): Promise<void> => {
  await ensureOk(client.api["shared-contents"][":id"].$delete({ param: { id } }));
};

/**
 * 表示名の変更。URL・状態・成果物は変わらない（200、変更後の DTO）。
 * provider を呼ばないので、公開中でも送れるが、画面の導線は状態が確定してから出す。
 */
export const renameSharedContent = async (id: string, name: string): Promise<SharedContentResponse> => {
  const res = await ensureOk(client.api["shared-contents"][":id"].$patch({ param: { id }, json: { name } }));
  return res.json();
};

/**
 * サムネイルの保存（差し替え）。本文は PNG の実バイトを raw で送る（JSON にしない）。
 * hc は JSON 本文を前提にするため、raw を送るこの 1 本だけ fetch を使う。
 * 公開状態を見ないので、公開処理中でも送れる。
 */
export const putSharedContentThumbnail = (id: string, bytes: Uint8Array) =>
  read<SharedContentThumbnailResponse>(
    fetch(`/api/shared-contents/${encodeURIComponent(id)}/thumbnail`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes as unknown as BodyInit,
    }),
  );

/** サムネイルだけを外す。未設定でも成功する（204） */
export const deleteSharedContentThumbnail = async (id: string): Promise<void> => {
  await ensureOk(client.api["shared-contents"][":id"].thumbnail.$delete({ param: { id } }));
};

/**
 * 設定 → 共有「公開の除外」の一覧。アーカイブの設定とは別の行で、プレビューと公開の両方に効く実効値。
 * 形はアーカイブの設定と同じ（`overridden` / 上限を含む）。
 */
export const getSharedContentExclusions = async (): Promise<SharedContentExclusionsResponse> => {
  const res = await ensureOk(client.api.settings["shared-content-exclusions"].$get());
  return res.json();
};

export const updateSharedContentExclusions = async (
  excludeNames: string[],
): Promise<SharedContentExclusionsResponse> => {
  const res = await ensureOk(client.api.settings["shared-content-exclusions"].$put({ json: { excludeNames } }));
  return res.json();
};

/** 保存行を消して未設定へ戻す（既定名を保存し直さないので、将来の既定の追加に追随する） */
export const resetSharedContentExclusions = async (): Promise<SharedContentExclusionsResponse> => {
  const res = await ensureOk(client.api.settings["shared-content-exclusions"].$delete());
  return res.json();
};
