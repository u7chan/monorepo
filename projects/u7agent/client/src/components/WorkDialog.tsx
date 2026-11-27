import { useEffect, useRef, type FormEvent, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/cn";
import { ModalDialog, type ModalDialogHandle } from "./ModalDialog";
import { CloseIcon } from "./icons";

export type WorkDialogNote = {
  /** フッターの 1 行。エラー / 実行できない理由 / 案内のどれを出すかは呼び出し側が決める */
  text: string;
  /** エラー・実行できない理由として読ませる (alert で読み上げ、danger 色) */
  danger: boolean;
};

export type WorkDialogProps = {
  /** ヘッダー左上の小さい英字 (面の種類) */
  eyebrow: string;
  /** 見出し。読み上げ名 (`aria-label`) も兼ねる */
  title: string;
  /** 実行中。ヘッダーの X / キャンセル / Escape を止める (docs/testing.md の「実行中は閉じない」) */
  busy: boolean;
  /** 閉じる。X とキャンセルは同じ経路を通る */
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * 初期焦点を置く要素 (フッターのキャンセル)。実行できない操作を Enter で確定させないためキャンセルへ置く。
   * 呼び出し側の ref 名は問わない (`cancelRef` / `closeRef` のどちらでも渡せる)
   */
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  /**
   * ヘッダーの X の ref。完了でフッター (キャンセル) が消える面は、焦点を残る閉じる導線である X へ移す
   */
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  /**
   * 実行成功など、X / キャンセル以外の経路で閉じるための handle。退場アニメを挟むため、
   * 呼び出し側は `onClose` ではなくこれを呼ぶ (省略すると殻が内部で持つ)
   */
  handleRef?: RefObject<ModalDialogHandle | null>;
  /**
   * 主ボタン。**省略するとフッターを描かない**: 結果を残す面は、完了後に X だけを閉じる導線として残す
   * (docs/ui-layout.md の「段階で出口を変える」)
   */
  submit?: { label: string; tone: "primary" | "danger"; disabled: boolean };
  /** フッターの注記。省略するとフッターはアクション行だけになる (注記行は任意) */
  note?: WorkDialogNote;
  /** ヘッダーとフォームの間の帯 (タブ行など、本文の外に置く操作) */
  toolbar?: ReactNode;
  /** 幅。`wide` は一覧・複数列を持つ面 (narrow は 1 列の確認) */
  width?: "narrow" | "wide";
  /**
   * 本文の組み方。`prose` は説明文を積む面、`dense` は行の多い一覧を持つ面 (項目間を詰める)、
   * `fields` は入力欄を積む面 (行間は各欄が持つ)。行間・項目間は殻が持ち、呼び出し側は class を渡さない
   */
  body?: "prose" | "dense" | "fields";
  singleColumn?: boolean;
  /** 本文 (スクロール領域の中身)。選択 UI・トグル・確認文言は呼び出し側が持つ */
  children: ReactNode;
};

/**
 * 作業面のダイアログの殻。ヘッダー・本文スクロール・フッターとモーダルの後始末を 1 か所に持つ。
 * 実行中は Escape / X / キャンセルを止め、初期焦点はキャンセルに置く (閉じる導線は docs/testing.md)。
 */
/** 本文の組み方。行間・項目間・文字の大きさは殻が持ち、呼び出し側は class を渡さない (docs/frontend.md) */
const BODY_CLASS = {
  prose: "grid min-h-0 flex-1 scrollbar-thin content-start gap-3.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed",
  dense: "grid min-h-0 flex-1 scrollbar-thin content-start gap-3 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed",
  fields: "grid min-h-0 flex-1 scrollbar-thin content-start gap-3.5 overflow-y-auto px-4 py-3.5",
} as const;

export function WorkDialog({
  eyebrow,
  title,
  busy,
  onClose,
  onSubmit,
  initialFocusRef,
  closeButtonRef,
  handleRef,
  submit,
  note,
  toolbar,
  width = "narrow",
  body = "prose",
  singleColumn = false,
  children,
}: WorkDialogProps) {
  const internalHandleRef = useRef<ModalDialogHandle | null>(null);
  const shellRef = handleRef ?? internalHandleRef;
  const requestClose = () => shellRef.current?.requestClose();

  // 初期焦点は取り消し側に置く (元に戻せない操作を Enter で確定させない)
  useEffect(() => {
    initialFocusRef.current?.focus();
  }, [initialFocusRef]);

  const actions = (
    <>
      <button
        ref={initialFocusRef}
        type="button"
        onClick={requestClose}
        className="btn-quiet singleColumn:min-h-11"
        disabled={busy}
      >
        キャンセル
      </button>
      <button
        type="submit"
        disabled={submit?.disabled ?? true}
        className={submit?.tone === "danger" ? "btn-danger singleColumn:min-h-11" : "btn-primary singleColumn:min-h-11"}
      >
        {submit?.label}
      </button>
    </>
  );

  return (
    <ModalDialog
      label={title}
      frame={singleColumn ? "fullscreen" : width === "wide" ? "wide" : "narrow"}
      className="flex flex-col"
      busy={busy}
      handleRef={shellRef}
      onClosed={onClose}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">{eyebrow}</div>
          <h2 className="text-md font-semibold text-ink-strong">{title}</h2>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={requestClose}
          aria-label="閉じる"
          title="閉じる"
          className="btn-quiet size-9 shrink-0 p-0 singleColumn:size-11"
          disabled={busy}
        >
          <CloseIcon />
        </button>
      </header>

      {toolbar}

      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className={BODY_CLASS[body]}>{children}</div>

        {/* 主ボタンが無い = 実行するものが残っていない面。出口はヘッダーの X だけにする */}
        {submit === undefined ? null : note === undefined ? (
          // 注記を持たない面はアクション行だけ。注記ありの面は注記を上に固定する
          // (長い理由でボタンが縦中央に浮かない)
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            {actions}
          </footer>
        ) : (
          <footer className="grid shrink-0 gap-1.5 border-t border-line px-4 py-3">
            <p
              role={note.danger ? "alert" : undefined}
              className={cn("min-w-0 text-1xs leading-relaxed", note.danger ? "text-danger-text" : "text-ink-muted")}
            >
              {note.text}
            </p>
            <div className="flex items-center justify-end gap-2">{actions}</div>
          </footer>
        )}
      </form>
    </ModalDialog>
  );
}
