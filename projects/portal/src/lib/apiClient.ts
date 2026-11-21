export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ErrorReader = (body: unknown, fallback: string) => string;
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RequestJsonOptions {
  init?: RequestInit;
  readError?: ErrorReader;
  parseOk?: (response: Response) => Promise<unknown>;
  fetchImpl?: FetchLike;
}

function readStringField(body: unknown, key: "message" | "error"): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readApiError(body: unknown, fallback: string): string {
  return readStringField(body, "message") ?? readStringField(body, "error") ?? fallback;
}

export function readApiMessage(body: unknown, fallback: string): string {
  return readStringField(body, "message") ?? fallback;
}

export function readStatusError(_body: unknown, fallback: string): string {
  return fallback;
}

export async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function requestJson(
  input: RequestInfo | URL,
  fallback: (status: number) => string,
  {
    init,
    readError = readApiError,
    parseOk = (response) => response.json(),
    fetchImpl = fetch,
  }: RequestJsonOptions = {},
): Promise<unknown> {
  const response = await fetchImpl(input, init);

  if (!response.ok) {
    const body = await readJsonBody(response);
    throw new ApiError(readError(body, fallback(response.status)), response.status, body);
  }

  return parseOk(response);
}
