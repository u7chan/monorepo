// 要求の組み立てと応答の読み取りだけを置く。stub / fixture をここへ寄せないのは、テストごとに固定する内容が違うため。

export const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

export const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export const jsonPatch = (payload: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

/** `Content-Type` は本文の種類を決める呼び出し側が付ける (ここで足すと要求の中身が変わる) */
export const authHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
