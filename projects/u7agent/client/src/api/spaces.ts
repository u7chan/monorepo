import type { Space } from "server";
import { client, read } from "./http";

export const listSpaces = () => read<{ spaces: Space[] }>(client.api.spaces.$get());

export const createSpace = (name: string) => read<{ space: Space }>(client.api.spaces.$post({ json: { name } }));

/**
 * 追加スペースの表示名を変える。応答は改名後の `space` で、id と createdAt・並びは変わらない。
 * 入力の検証はサーバーが行うため、理由の文言はサーバーの応答をそのまま画面へ出す。
 */
export const renameSpace = (id: string, name: string) =>
  read<{ space: Space }>(client.api.spaces[":id"].$patch({ param: { id }, json: { name } }));

/**
 * 追加スペースを箱ごと消す。削除対象は id なので、文脈の `spaceId` は付けない (既定スペースは 400、公開中の
 * サービスがあれば 409 で、理由はサーバーの文言をそのまま画面へ出す)。
 */
export const deleteSpace = (id: string) => read<{ ok: true }>(client.api.spaces[":id"].$delete({ param: { id } }));

/** 並べ替え。応答の spaces がサーバーの採用した順（既定スペースは先頭、`sortOrder` は出ない） */
export const reorderSpaces = (ids: readonly string[]) =>
  read<{ spaces: Space[] }>(client.api.spaces.order.$patch({ json: { ids: [...ids] } }));
