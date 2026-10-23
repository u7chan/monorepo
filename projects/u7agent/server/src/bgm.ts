import { parseJsonBody, providerMessageOf } from "./provider-failure";

export const BGM_MODEL = "google/lyria-3-clip-preview";
export const BGM_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const BGM_EXPECTED_DURATION_SECONDS = 30;
export const BGM_TIMEOUT_MS = 180_000;
export const BGM_MAX_CONCURRENT = 2;
export const BGM_PROMPT_MAX_LENGTH = 1_000;
export const BGM_PATH_MAX_LENGTH = 800;
export const BGM_LIMITS = {
  audio: 32 * 1024 * 1024,
  event: 48 * 1024 * 1024,
  total: 64 * 1024 * 1024,
  error: 64 * 1024,
} as const;

export interface BgmGenerationSettings {
  model: typeof BGM_MODEL;
  apiKey: string;
}

export interface BgmGenerationInput {
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface BgmGeneratorOptions {
  fetchImpl?: typeof fetch;
  maskText?: (text: string) => string;
  limits?: Partial<Record<keyof typeof BGM_LIMITS, number>>;
}

export function bgmSettings(configured: boolean) {
  return {
    model: configured ? BGM_MODEL : null,
    format: "mp3",
    expectedDurationSeconds: BGM_EXPECTED_DURATION_SECONDS,
  } as const;
}

/** fetch や upload の実装が signal を無視しても、呼出し側の期限を延長させない。 */
export async function bgmAbortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("BGM生成を中断しました"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("未対応のBGM応答です");
  return value as Record<string, unknown>;
}

function decodeAudio(data: unknown, remaining: number): Buffer {
  if (typeof data !== "string" || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) {
    throw new Error("BGMのBase64が不正です");
  }
  const padding = data.indexOf("=");
  if (padding >= 0 && !(padding === data.length - 1 || (padding === data.length - 2 && data.endsWith("=="))))
    throw new Error("BGMのBase64 paddingが不正です");
  const size = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > remaining) throw new Error("BGMの音声サイズ上限を超えました");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("BGMのBase64 paddingが不正です");
  return bytes;
}

export function assertBgmMp3(bytes: Uint8Array): void {
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]!) || bytes.slice(6, 10).some((byte) => byte > 0x7f)) {
      throw new Error("BGMのMP3ヘッダが不正です");
    }
    offset = 10 + bytes.slice(6, 10).reduce((size, byte) => size * 128 + byte, 0);
    if (bytes[3] === 4 && (bytes[5]! & 0x10) !== 0) offset += 10;
  }
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  if (
    bytes.length < offset + 5 ||
    bytes[offset] !== 0xff ||
    (b1 & 0xe0) !== 0xe0 ||
    (b1 & 0x18) === 0x08 ||
    (b1 & 0x06) !== 0x02 ||
    (b2 & 0xf0) === 0 ||
    (b2 & 0xf0) === 0xf0 ||
    (b2 & 0x0c) === 0x0c
  )
    throw new Error("BGMの音声がMP3ではありません");
}

export function createBgmGenerator(options: BgmGeneratorOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limits = { ...BGM_LIMITS, ...options.limits };
  const mask = options.maskText ?? ((text: string) => text);

  return {
    async generate(input: BgmGenerationInput): Promise<Uint8Array<ArrayBuffer>> {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        input.signal.throwIfAborted();
        const pending = fetchImpl(BGM_API_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
          body: JSON.stringify({
            model: BGM_MODEL,
            messages: [{ role: "user", content: `${input.prompt}\n\nInstrumental only, no vocals.` }],
            modalities: ["text", "audio"],
            audio: { format: "mp3" },
            stream: true,
          }),
          signal: input.signal,
        });
        void pending.then(
          (response) => {
            if (input.signal.aborted) void response.body?.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await bgmAbortable(pending, input.signal);
        if (!response.body) throw new Error("BGMの応答本文がありません");
        reader = response.body.getReader();
        if (!response.ok) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = await bgmAbortable(reader.read(), input.signal);
            if (next.done) break;
            size += next.value.length;
            if (size > limits.error) throw new Error(`BGM HTTP ${response.status}: エラー本文の上限を超えました`);
            chunks.push(next.value);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          throw new Error(
            `BGM HTTP ${response.status}: ${mask(providerMessageOf(parseJsonBody(raw), raw, true) ?? "生成失敗").slice(0, 500)}`,
          );
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream") {
          throw new Error("BGMの応答がSSEではありません");
        }

        const audio: Buffer[] = [];
        let audioSize = 0;
        let total = 0;
        let eventSize = 0;
        let lineSize = 0;
        let pendingCr = false;
        let parts: Buffer[] = [];
        let partBytes = 0;
        const append = (bytes: Buffer) => {
          const capacity = 64 * 1024;
          let offset = 0;
          while (offset < bytes.length) {
            const used = partBytes % capacity;
            if (used === 0) parts.push(Buffer.allocUnsafe(capacity));
            const length = Math.min(capacity - used, bytes.length - offset);
            bytes.copy(parts[parts.length - 1], used, offset, offset + length);
            offset += length;
            partBytes += length;
          }
        };
        let finished = false;
        let done = false;
        let trackId: string | undefined;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const dispatch = () => {
          const text = decoder.decode(Buffer.concat(parts, partBytes));
          parts = [];
          partBytes = 0;
          const data = text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") return;
          if (data === "[DONE]") {
            if (!finished || audioSize === 0) throw new Error("BGMが正常に完了していません");
            done = true;
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new Error("BGMのSSE JSONが不正です");
          }
          const frame = record(parsed);
          if (frame.error != null)
            throw new Error(providerMessageOf(frame, "", false) ?? "BGMのストリーム内エラーです");
          if (!Array.isArray(frame.choices) || frame.choices.length > 1)
            throw new Error("BGMは1トラックだけ対応しています");
          if (frame.choices.length === 0) {
            if (!frame.usage) throw new Error("未対応のBGMイベントです");
            return;
          }
          const choice = record(frame.choices[0]);
          if (choice.index !== undefined && choice.index !== 0) throw new Error("複数BGMには対応していません");
          const delta = record(choice.delta);
          if (delta.refusal || choice.refusal) throw new Error("BGM生成が拒否されました");
          if (delta.audio !== undefined && delta.audio !== null) {
            const chunk = record(delta.audio);
            if (chunk.id !== undefined) {
              if (typeof chunk.id !== "string" || chunk.id === "" || (trackId !== undefined && trackId !== chunk.id))
                throw new Error("複数BGMには対応していません");
              trackId = chunk.id;
            }
            if (chunk.data !== undefined) {
              if (finished) throw new Error("BGM終端後に音声が届きました");
              const bytes = decodeAudio(chunk.data, limits.audio - audioSize);
              audioSize += bytes.length;
              if (bytes.length) audio.push(bytes);
            }
          }
          if (choice.finish_reason != null) {
            if (choice.finish_reason !== "stop") throw new Error("BGMが異常終了しました");
            if (finished && !frame.usage) throw new Error("BGM終端が重複しています");
            finished = true;
          }
        };
        const endLine = () => {
          if (lineSize === 0) {
            dispatch();
            eventSize = 0;
          } else append(Buffer.from("\n"));
          lineSize = 0;
        };
        while (!done) {
          const next = await bgmAbortable(reader.read(), input.signal);
          if (next.done) {
            if (pendingCr) endLine();
            if (done) break;
            throw new Error("BGMのSSEが途中で切断されました");
          }
          total += next.value.length;
          if (total > limits.total) throw new Error("BGMの総受信サイズ上限を超えました");
          const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
          let start = 0;
          while (start < bytes.length && !done) {
            if (pendingCr) {
              pendingCr = false;
              if (bytes[start] === 10) {
                eventSize += 1;
                if (eventSize > limits.event) throw new Error("BGMのSSEイベントサイズ上限を超えました");
                endLine();
                start += 1;
                continue;
              }
              endLine();
              if (done) break;
            }
            const cr = bytes.indexOf(13, start);
            const lf = bytes.indexOf(10, start);
            const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
            const stop = end < 0 ? bytes.length : end;
            const fragment = bytes.subarray(start, stop);
            eventSize += fragment.length + (end < 0 ? 0 : 1);
            if (eventSize > limits.event) throw new Error("BGMのSSEイベントサイズ上限を超えました");
            append(fragment);
            lineSize += fragment.length;
            if (end < 0) break;
            pendingCr = bytes[end] === 13;
            if (!pendingCr) endLine();
            start = end + 1;
          }
        }
        input.signal.throwIfAborted();
        const result = new Uint8Array(Buffer.concat(audio, audioSize));
        assertBgmMp3(result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "BGM生成に失敗しました";
        throw new Error(mask(message).slice(0, 500));
      } finally {
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  };
}
