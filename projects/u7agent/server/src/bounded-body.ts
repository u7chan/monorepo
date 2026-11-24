interface ReadOptions {
  cancelOnLimit?: "wait" | "background";
  cancelOnReadError?: boolean;
}

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

export function declaredBodyTooLarge(declared: number, maxBytes: number): boolean {
  return Number.isFinite(declared) && declared > maxBytes;
}

// Content-Length は受信バイト数を保証しない。reader の lock は取得元が管理する。
async function readWithinLimit<T>(
  reader: BodyReader | undefined,
  maxBytes: number,
  append: (chunk: Uint8Array) => void,
  finish: (size: number) => T,
  options: ReadOptions,
): Promise<T | undefined> {
  if (!reader) return finish(0);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return finish(size);
      size += value.byteLength;
      if (size > maxBytes) {
        const canceled = reader.cancel().catch(() => {});
        // tee された本文では、もう片方の読み取りを待つと応答を返せなくなる経路がある。
        if (options.cancelOnLimit !== "background") await canceled;
        return undefined;
      }
      append(value);
    }
  } catch (error) {
    if (options.cancelOnReadError) await reader.cancel().catch(() => {});
    throw error;
  }
}

export function readBodyBytes(reader: BodyReader | undefined, maxBytes: number): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  return readWithinLimit(
    reader,
    maxBytes,
    (chunk) => chunks.push(chunk),
    (size) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
    {},
  );
}

export function readBodyText(
  reader: BodyReader | undefined,
  maxBytes: number,
  options: ReadOptions = {},
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = "";
  return readWithinLimit(
    reader,
    maxBytes,
    (chunk) => {
      text += decoder.decode(chunk, { stream: true });
    },
    () => text + decoder.decode(),
    options,
  );
}

export async function readCappedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (declaredBodyTooLarge(declared, maxBytes)) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return "";
  const bytes = await readBodyBytes(response.body.getReader(), maxBytes);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
