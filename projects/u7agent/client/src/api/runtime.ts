import { client, read } from "./http";
import type {
  Health,
  RuntimeDebugServeStatus,
  RuntimeDebugServeStopResult,
  RuntimeEnvironmentResponse,
  RuntimeInUseResponse,
  RuntimeModelsResponse,
  RuntimeServeStatus,
} from "../types";

export const getHealth = () => read<Health>(client.api.health.$get());

export const getRuntimeModels = () => read<RuntimeModelsResponse>(client.api.runtime.models.$get());

/**
 * 実行環境の診断。未接続を含む 6 状態を HTTP 200 で返すため、ここでの失敗は BFF 自体の異常を表す。
 * UI は HTTP ステータスではなく応答の `state` で分岐する。
 */
export const getRuntimeEnvironment = () => read<RuntimeEnvironmentResponse>(client.api.runtime.environment.$get());

/**
 * 環境タブが「いま使われるモデル」と「外部連携」を 1 回で読むための集約。設定 API のカタログは含まない。
 * 失敗は BFF / アプリ DB の異常を表し、UI は取得状態 (loading / ready / error) で分岐する。
 */
export const getRuntimeInUse = () => read<RuntimeInUseResponse>(client.api.runtime["in-use"].$get());

export const getRuntimeServeStatus = (signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.status.$get({}, { init: { signal } }));

export const stopRuntimeServe = (input: { generation: string }, signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.stop.$post({ json: input }, { init: { signal } }));

/**
 * 実行状況からの起動。会話の所属スペースを問わず、応答は全体の状態 (runtime status と同じ形)。
 * `generation` は確認を表示した時点の値で、実行時に変わっていれば 409。
 */
export const startRuntimeServe = (input: { sessionId: string; generation: string | null }, signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.start.$post({ json: input }, { init: { signal } }));

/**
 * デバッグ枠 (18000–18099) の一覧。公開枠の status とは別に取得し、失敗をデバッグ節の中だけに閉じる。
 * 一覧は軽い走査だけで、待受 PID の特定は停止のときに行う。
 */
export const getRuntimeDebugServeStatus = (signal?: AbortSignal) =>
  read<RuntimeDebugServeStatus>(client.api.serve.debug.status.$get({}, { init: { signal } }));

/** 設定 → ランタイム からの強制停止。所有者を問わず、指定したレンジ内のポートを停止する */
export const stopRuntimeDebugServe = (input: { port: number }, signal?: AbortSignal) =>
  read<RuntimeDebugServeStopResult>(client.api.serve.debug.stop.$post({ json: input }, { init: { signal } }));
