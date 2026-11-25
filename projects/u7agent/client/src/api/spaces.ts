import type { Space } from "server";
import { client, ensureOk } from "./http";

export const listSpaces = async (): Promise<{ spaces: Space[] }> => {
  const res = await ensureOk(client.api.spaces.$get());
  return res.json();
};

export const createSpace = async (name: string): Promise<{ space: Space }> => {
  const res = await ensureOk(client.api.spaces.$post({ json: { name } }));
  return res.json();
};

/**
 * 追加スペースの表示名を変える。応答は改名後の `space` で、id と createdAt・並びは変わらない。
 * 入力の検証はサーバーが行うため、理由の文言はサーバーの応答をそのまま画面へ出す。
 */
export const renameSpace = async (id: string, name: string): Promise<{ space: Space }> => {
  const res = await ensureOk(client.api.spaces[":id"].$patch({ param: { id }, json: { name } }));
  return res.json();
};

/**
 * 追加スペースを箱ごと消す。削除対象は id なので、文脈の `spaceId` は付けない (既定スペースは 400、公開中の
 * サービスがあれば 409 で、理由はサーバーの文言をそのまま画面へ出す)。
 */
export const deleteSpace = async (id: string): Promise<{ ok: true }> => {
  const res = await ensureOk(client.api.spaces[":id"].$delete({ param: { id } }));
  return res.json();
};

/** 並べ替え。応答の spaces がサーバーの採用した順（既定スペースは先頭、`sortOrder` は出ない） */
export const reorderSpaces = async (ids: readonly string[]): Promise<{ spaces: Space[] }> => {
  const res = await ensureOk(client.api.spaces.order.$patch({ json: { ids: [...ids] } }));
  return res.json();
};
