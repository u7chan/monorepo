import { randomBytes } from "node:crypto";
import type { AppDb } from "./app-db";
import { httpError } from "./http";
import type { Space } from "./schema";

export const DEFAULT_SPACE_ID = "default";
export const DEFAULT_SPACE: Space = { id: DEFAULT_SPACE_ID, name: "通常", createdAt: 0 };

export function isSpaceId(value: unknown): value is string {
  return typeof value === "string" && (value === DEFAULT_SPACE_ID || /^space-[0-9a-f]{16}$/.test(value));
}

export function spaceIdOf(value: unknown): string {
  if (value === undefined) return DEFAULT_SPACE_ID;
  if (!isSpaceId(value)) throw httpError(400, "スペース ID が不正です");
  return value;
}

export class SpaceStore {
  constructor(private readonly db: AppDb) {}

  list(): Space[] {
    return [DEFAULT_SPACE, ...this.db.listSpaces()];
  }

  require(value: unknown): string {
    const id = spaceIdOf(value);
    // 通常の停止・削除は DB 障害時にも塞がない。
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
}
