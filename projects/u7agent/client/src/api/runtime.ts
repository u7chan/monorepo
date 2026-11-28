import { client, ensureOk, read } from "./http";
import type {
  Health,
  RuntimeDebugServeStatus,
  RuntimeDebugServeStopResult,
  RuntimeEnvironmentResponse,
  RuntimeInUseResponse,
  RuntimeModelsResponse,
  RuntimeServeStatus,
  ServeTunnelStartBody,
  ServeTunnelStatus,
} from "../types";

export const getHealth = async (): Promise<Health> => {
  const res = await ensureOk(client.api.health.$get());
  return res.json();
};

export const getRuntimeModels = async (): Promise<RuntimeModelsResponse> => {
  const res = await ensureOk(client.api.runtime.models.$get());
  return res.json();
};

/** 未接続も 200 の応答の `state` で返る。ここでの失敗は BFF 自体の異常なので、UI は status ではなく `state` で分岐する */
export const getRuntimeEnvironment = async (): Promise<RuntimeEnvironmentResponse> => {
  const res = await ensureOk(client.api.runtime.environment.$get());
  return res.json();
};

/** 設定 API のカタログは含まない。UI は取得状態 (loading / ready / error) で分岐する */
export const getRuntimeInUse = async (): Promise<RuntimeInUseResponse> => {
  const res = await ensureOk(client.api.runtime["in-use"].$get());
  return res.json();
};

export const getRuntimeServeStatus = (signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.status.$get({}, { init: { signal } }));

export const stopRuntimeServe = (input: { generation: string }, signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.stop.$post({ json: input }, { init: { signal } }));

/** `generation` は確認を表示した時点の値で、実行時に変わっていれば 409。UI は状態を取り直して確認し直す */
export const startRuntimeServe = (input: { sessionId: string; generation: string | null }, signal?: AbortSignal) =>
  read<RuntimeServeStatus>(client.api.serve.runtime.start.$post({ json: input }, { init: { signal } }));

/** 一時共有の状態。全体で 1 本で、サービスの状態とは独立に続く (ガード無しの GET) */
export const getServeTunnel = (signal?: AbortSignal) =>
  read<ServeTunnelStatus>(client.api.serve.tunnel.$get({}, { init: { signal } }));

/** `generation` は確認を表示した時点の値。実行時に変わっていれば 409 で、UI は確認をやり直す */
export const startServeTunnel = (input: ServeTunnelStartBody, signal?: AbortSignal) =>
  read<ServeTunnelStatus>(client.api.serve.tunnel.start.$post({ json: input }, { init: { signal } }));

/** 冪等。共有が無くても `idle` を返し、`starting` 中なら開始を中断する */
export const stopServeTunnel = (signal?: AbortSignal) =>
  read<ServeTunnelStatus>(client.api.serve.tunnel.stop.$post({}, { init: { signal } }));

export const getRuntimeDebugServeStatus = (signal?: AbortSignal) =>
  read<RuntimeDebugServeStatus>(client.api.serve.debug.status.$get({}, { init: { signal } }));

export const stopRuntimeDebugServe = (input: { port: number }, signal?: AbortSignal) =>
  read<RuntimeDebugServeStopResult>(client.api.serve.debug.stop.$post({ json: input }, { init: { signal } }));
