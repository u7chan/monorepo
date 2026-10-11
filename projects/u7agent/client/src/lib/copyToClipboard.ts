/**
 * navigator.clipboard は Secure Context (https / localhost) 専用のため、http では document.execCommand("copy")
 * へフォールバックする (https でも権限・フォーカス等で失敗した場合を含む)。
 *
 * WebKit の execCommand は「実 selection」と「viewport 内に描画された要素」を要求し、必要な条件が版ごとに違う
 * ため、1 経路ずつ順に試す (経路と順序の根拠は docs/sandbox.md)。どれも通らなければ試した内訳を message に
 * 入れて投げ、UI が失敗の通知に出す。
 */

/** execCommand 経路で使う一時要素。本文の選択は経路ごと (textarea / contenteditable) に作る */
export type ClipboardTarget = {
  /**
   * 一時要素へフォーカスし、実際にフォーカスできたかを返す。modal dialog の外は inert でフォーカスできず、
   * その状態の textarea は内部 selection だけを持って execCommand が true を返す (空をコピーしたまま成功)
   */
  focus(): boolean;
  /** 実 selection を作り、プラットフォームが見ている選択文字列を返す (空 selection の検出に使う) */
  select(): string;
  remove(): void;
};

/**
 * 試す順の経路。新しい WebKit は editable な要素、Safari 15 以前は readonly な textarea を要求するため、
 * どちらも残す (textarea が使えない環境のために DOM の選択だけでコピーする経路も持つ)。
 */
export type CopyStrategy = "editable-textarea" | "readonly-textarea" | "contenteditable";

const COPY_STRATEGIES: readonly CopyStrategy[] = ["editable-textarea", "readonly-textarea", "contenteditable"];

const STRATEGY_LABEL: Record<CopyStrategy, string> = {
  "editable-textarea": "textarea",
  "readonly-textarea": "readonly textarea",
  contenteditable: "contenteditable",
};

/** 失敗の通知に出す理由 1 件の長さ。例外のメッセージが長い場合だけ切る */
const MAX_REASON_LENGTH = 120;

/** コピーできなかった理由。message に試した経路の内訳 (原因の切り分けに使う) を入れる */
export class ClipboardCopyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ClipboardCopyError";
  }
}

/** DOM と clipboard への入口。テストでは全部差し替える */
export type ClipboardDeps = {
  isSecureContext: boolean;
  /** navigator.clipboard?.writeText 相当。API 非対応は undefined */
  writeText?: ((text: string) => Promise<void>) | undefined;
  /** document.execCommand 相当 */
  execCommand: (command: "copy") => boolean;
  /** 経路ごとの一時要素を本文つきで作り、body へ付けて返す */
  createTarget: (strategy: CopyStrategy, text: string) => ClipboardTarget;
  saveSelection: () => SelectionSnapshot;
  restoreSelection: (snapshot: SelectionSnapshot) => void;
};

/** コピー前のフォーカス / selection。実装と差し替えで同じ型を使う */
export type SelectionSnapshot = {
  active: HTMLElement | null;
  text: { start: number; end: number; direction: "forward" | "backward" | "none" } | null;
  range: Range | null;
};

export async function copyToClipboard(text: string, deps: ClipboardDeps = browserClipboardDeps()): Promise<void> {
  const failures: string[] = [];
  if (!deps.isSecureContext) {
    // 非 secure context では navigator.clipboard が生えない (生えていても secure 前提の API)
    failures.push("非 secure context");
  } else if (deps.writeText === undefined) {
    failures.push("clipboard API なし");
  } else {
    try {
      await deps.writeText(text);
      return;
    } catch (error) {
      failures.push(`clipboard API: ${reasonText(error)}`);
    }
  }

  const saved = deps.saveSelection();
  try {
    for (const strategy of COPY_STRATEGIES) {
      const target = deps.createTarget(strategy, text);
      try {
        // フォーカスできない経路 (inert な場所に付いた) では execCommand を信じない
        if (!target.focus()) {
          failures.push(`${STRATEGY_LABEL[strategy]}: フォーカスできない`);
        } else {
          const selected = target.select();
          // execCommand は選択が空でも成功を返す (そのまま空をコピーする) ため、選択そのものを確かめる
          if (text !== "" && selected === "") {
            failures.push(`${STRATEGY_LABEL[strategy]}: 選択が空`);
          } else if (deps.execCommand("copy")) {
            return;
          } else {
            failures.push(`${STRATEGY_LABEL[strategy]}: execCommand が false`);
          }
        }
      } catch (error) {
        failures.push(`${STRATEGY_LABEL[strategy]}: ${reasonText(error)}`);
      } finally {
        target.remove();
      }
    }
  } finally {
    deps.restoreSelection(saved);
  }

  throw new ClipboardCopyError(failures.join(" / "));
}

/**
 * コピーできなかったときの手動の導線。本文を選択状態にし、長押し / Ctrl+C などのブラウザーの標準操作へ渡す
 * (選択を解除するのは利用者に任せる)。畳まれた details の中身は選択できないため、対象を含む details は先に
 * 開く。対象が画面に出ていないコピー (診断情報など) では呼ばない
 */
export function selectCopyTarget(element: Element | null): void {
  if (element === null) return;
  for (const details of element.querySelectorAll("details")) details.open = true;
  for (
    let parent = element.closest("details");
    parent !== null;
    parent = parent.parentElement?.closest("details") ?? null
  ) {
    parent.open = true;
  }
  const selection = document.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function reasonText(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}

function browserClipboardDeps(): ClipboardDeps {
  return {
    isSecureContext: window.isSecureContext,
    writeText: navigator.clipboard === undefined ? undefined : (text: string) => navigator.clipboard.writeText(text),
    execCommand: (command) => document.execCommand(command),
    createTarget: (strategy, text) =>
      strategy === "contenteditable" ? createContentEditableTarget(text) : createTextAreaTarget(strategy, text),
    saveSelection,
    restoreSelection,
  };
}

/**
 * 一時要素を付ける先。modal dialog の外は inert で、focus() しても \`document.activeElement\` が動かず、
 * 実 selection の無いまま execCommand が true を返す (空をコピーしたのに成功になる)。開いている dialog が
 * あればその中へ入れる
 */
function clipboardHost(): HTMLElement {
  const active = document.activeElement;
  const fromActive = active instanceof Element ? active.closest("dialog[open]") : null;
  if (fromActive instanceof HTMLElement) return fromActive;
  // 最前面は top layer へ最後に載った dialog で、DOM 順の最後と一致する
  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  return dialogs[dialogs.length - 1] ?? document.body;
}

/**
 * 一時要素の置き方。画面外 (left: -9999px) や display: none / visibility: hidden では WebKit が選択を
 * 作らないため、viewport の左上に置いて透明にする。大きさは 0 にしない (描画された箱が要る)
 */
function placeAtViewportOrigin(element: HTMLElement): void {
  const { style } = element;
  style.position = "fixed";
  style.top = "0";
  style.left = "0";
  style.width = "2em";
  style.height = "2em";
  style.margin = "0";
  style.padding = "0";
  style.border = "0";
  style.opacity = "0";
  style.pointerEvents = "none";
  // iOS は 16px 未満の入力欄の focus で自動ズームする
  style.fontSize = "16px";
  // WebKit は user-select が none の要素から選択を作れない。親の指定に負けないよう important を付ける
  style.setProperty("-webkit-user-select", "text", "important");
  style.userSelect = "text";
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
}

function createTextAreaTarget(strategy: CopyStrategy, text: string): ClipboardTarget {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  if (strategy === "readonly-textarea") {
    // Safari 15 以前は editable な textarea の select() からコピーできない
    textarea.readOnly = true;
  }
  // focus でソフトウェアキーボードを出さない
  textarea.inputMode = "none";
  placeAtViewportOrigin(textarea);
  clipboardHost().appendChild(textarea);
  return {
    focus: () => {
      textarea.focus({ preventScroll: true });
      return document.activeElement === textarea;
    },
    select: () => {
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      return textarea.value.slice(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
    },
    remove: () => textarea.remove(),
  };
}

function createContentEditableTarget(text: string): ClipboardTarget {
  const div = document.createElement("div");
  div.contentEditable = "true";
  div.textContent = text;
  // 既定の white-space: normal だと execCommand が改行と連続空白を潰して書き出す (契約は本文をそのまま渡すこと)
  div.style.whiteSpace = "pre-wrap";
  div.style.overflow = "hidden";
  placeAtViewportOrigin(div);
  clipboardHost().appendChild(div);
  return {
    focus: () => {
      div.focus({ preventScroll: true });
      return document.activeElement === div;
    },
    select: () => {
      const selection = document.getSelection();
      if (selection === null) return "";
      const range = document.createRange();
      range.selectNodeContents(div);
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    },
    remove: () => div.remove(),
  };
}

function saveSelection(): SelectionSnapshot {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const { selectionStart, selectionEnd, selectionDirection } = active;
    if (selectionStart !== null && selectionEnd !== null) {
      return {
        active,
        text: { start: selectionStart, end: selectionEnd, direction: selectionDirection ?? "none" },
        range: null,
      };
    }
  }
  const selection = document.getSelection();
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  return { active, text: null, range };
}

function restoreSelection(snapshot: SelectionSnapshot): void {
  // 一時要素へ移ったフォーカスを戻さないと、続けて打った文字が入力欄へ入らない
  snapshot.active?.focus({ preventScroll: true });
  if (
    snapshot.text !== null &&
    (snapshot.active instanceof HTMLTextAreaElement || snapshot.active instanceof HTMLInputElement)
  ) {
    snapshot.active.setSelectionRange(snapshot.text.start, snapshot.text.end, snapshot.text.direction);
    return;
  }
  if (snapshot.range !== null) {
    const selection = document.getSelection();
    if (selection !== null) {
      selection.removeAllRanges();
      selection.addRange(snapshot.range);
    }
  }
}
