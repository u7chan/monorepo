/**
 * API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。
 * 実体はドメイン別の `schema/` に分け、このファイルはバレルとして再エクスポートする
 * (呼び出し側の import 経路を変えないため)。
 */

export * from "./schema/common";
export * from "./schema/messages";
export * from "./schema/spaces";
export * from "./schema/files";
export * from "./schema/skills";
export * from "./schema/secrets";
export * from "./schema/catalog";
export * from "./schema/content";
export * from "./schema/sharing";
export * from "./schema/settings";
export * from "./schema/runtime";
export * from "./schema/session";
export * from "./schema/backup";
