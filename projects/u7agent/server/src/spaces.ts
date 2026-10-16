import { randomBytes } from "node:crypto";
import type { AppDb } from "./app-db";
import { httpError } from "./http";
import type { Space } from "./schema";

export const DEFAULT_SPACE_ID = "default";
export const DEFAULT_SPACE: Space = { id: DEFAULT_SPACE_ID, name: "既定", createdAt: 0 };

export function isSpaceId(value: unknown): value is string {
  return typeof value === "string" && (value === DEFAULT_SPACE_ID || /^space-[0-9a-f]{16}$/.test(value));
}

export function spaceIdOf(value: unknown): string {
  if (value === undefined) return DEFAULT_SPACE_ID;
  if (!isSpaceId(value)) throw httpError(400, "スペース ID が不正です");
  return value;
}

export class SpaceStore {
  /** 削除を進めている id。削除中はそのスペースへの scoped API を読み取りも含めて 404 にする */
  #deleting = new Set<string>();

  constructor(private readonly db: AppDb) {}

  list(): Space[] {
    return [DEFAULT_SPACE, ...this.db.listSpaces()];
  }

  /**
   * 削除の claim を取る。同期で取り、二重削除 (409) を DB 読みより先に返す。claim 済みの id は
   * `require` が 404 にするため、存在確認はここで行う。
   */
  claim(value: unknown): string {
    const id = spaceIdOf(value);
    if (id === DEFAULT_SPACE_ID) throw httpError(400, "既定スペースは削除できません");
    if (this.#deleting.has(id)) throw httpError(409, "スペースを削除しています");
    this.#deleting.add(id);
    try {
      if (!this.db.listSpaces().some((space) => space.id === id)) {
        throw httpError(404, "スペースが見つかりません");
      }
    } catch (error) {
      this.#deleting.delete(id);
      throw error;
    }
    return id;
  }

  release(id: string): void {
    this.#deleting.delete(id);
  }

  require(value: unknown): string {
    const id = spaceIdOf(value);
    // 削除中は読み取りも含めて 404 にする (削除の最中に同じスペースへ会話が作られる窓を閉じる)
    if (this.#deleting.has(id)) throw httpError(404, "スペースが見つかりません");
    // 既定スペースの停止・削除は DB 障害時にも塞がない。
    if (id !== DEFAULT_SPACE_ID && !this.db.listSpaces().some((space) => space.id === id)) {
      throw httpError(404, "スペースが見つかりません");
    }
    return id;
  }

  create(name: string): Space {
    const space = { id: `space-${randomBytes(8).toString("hex")}`, name, createdAt: Date.now() };
    this.db.insertSpace(space);
    return space;
  }

  /**
   * 並べ替え。既定スペース・未知の id・重複は捨て、渡されなかった行は元の相対順で末尾に回す
   * (`reorderAgents` と同じ方針。docs/api.md#スペース)。既定スペースは `list()` が先頭に置く。
   */
  reorder(ids: readonly string[]): Space[] {
    const current = this.db.listSpaces();
    const known = new Set(current.map((space) => space.id));
    const seen = new Set<string>();
    const order: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    for (const space of current) {
      if (!seen.has(space.id)) order.push(space.id);
    }
    this.db.reorderSpaces(order);
    return this.list();
  }
}
