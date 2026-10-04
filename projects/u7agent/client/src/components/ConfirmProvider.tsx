import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConfirmRequest, DialogRequest, PromptRequest } from "../lib/confirmDialog";
import { createDialogQueue } from "../lib/dialogQueue";
import { ConfirmDialog } from "./ConfirmDialog";

type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;
type PromptFn = (request: PromptRequest) => Promise<string | null>;

type DialogApi = { confirm: ConfirmFn; prompt: PromptFn };

type Pending = { id: number; request: DialogRequest; resolve: (value: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

/**
 * 共通の確認ダイアログをアプリ全体へ 1 つだけ置く。UI を持たないフック (`useSessions` / `useU7Agent`) からも
 * 同じ部品を使えるよう、`confirm()` は Promise を返し、Promise を返す点は `confirm` / `prompt` で揃える。
 * 文言とボタン名は呼び出し側が lib の純関数で組み立てる (`lib/confirmDialog.ts`)。
 * モーダルは 1 つだけ出し、開いている間の要求は待ち行列へ積む (`lib/dialogQueue.ts`。先の要求を
 * 未解決のまま捨てると、呼び出し側の `finally` が走らない)。
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue] = useState(() => createDialogQueue<Pending>());
  const [pending, setPending] = useState<Pending | null>(null);
  const seq = useRef(0);

  const open = useCallback(
    (request: DialogRequest): Promise<string | null> => {
      return new Promise((resolve) => {
        seq.current += 1;
        queue.push({ id: seq.current, request, resolve });
        setPending(queue.head() ?? null);
      });
    },
    [queue],
  );

  // 応答は先頭の要求にだけ対応付ける。画面を閉じてから resolve する (閉じた後に呼び出し側が次の操作を
  // 始めても、画面が残らない)
  const finish = useCallback(
    (id: number, value: string | null) => {
      const current = queue.head();
      if (!current || current.id !== id || !queue.settle(id)) return;
      setPending(queue.head() ?? null);
      current.resolve(value);
    },
    [queue],
  );

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (request) => open(request).then((value) => value !== null),
      prompt: (request) => open(request),
    }),
    [open],
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending ? (
        <ConfirmDialog
          key={pending.id}
          request={pending.request}
          onConfirm={(value) => finish(pending.id, value)}
          onCancel={() => finish(pending.id, null)}
        />
      ) : null}
    </DialogContext.Provider>
  );
}

function useDialogApi(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("ConfirmProvider の外で確認ダイアログを呼びました");
  return api;
}

/** 確認して実行する。取り消したら false (呼び出し側は後続の処理を呼ばない) */
export function useConfirm(): ConfirmFn {
  return useDialogApi().confirm;
}

/** 入力を受け取る。取り消したら null */
export function usePrompt(): PromptFn {
  return useDialogApi().prompt;
}
