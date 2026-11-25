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

/** 入力の検証はサーバーが行うため、理由の文言はサーバーの応答をそのまま画面へ出す */
export const renameSpace = async (id: string, name: string): Promise<{ space: Space }> => {
  const res = await ensureOk(client.api.spaces[":id"].$patch({ param: { id }, json: { name } }));
  return res.json();
};

/** 削除対象は id なので、文脈の `spaceId` は付けない。拒否の理由もサーバーの文言をそのまま画面へ出す */
export const deleteSpace = async (id: string): Promise<{ ok: true }> => {
  const res = await ensureOk(client.api.spaces[":id"].$delete({ param: { id } }));
  return res.json();
};

export const reorderSpaces = async (ids: readonly string[]): Promise<{ spaces: Space[] }> => {
  const res = await ensureOk(client.api.spaces.order.$patch({ json: { ids: [...ids] } }));
  return res.json();
};
