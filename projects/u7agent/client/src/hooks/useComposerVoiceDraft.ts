import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ConfirmFn } from "../components/ConfirmProvider";
import { deviceSettingsStorage } from "../lib/deviceSettingsStore";
import {
  voiceInputComposerBlockedReason,
  voiceInputComposerBusy,
  type VoiceInputComposerPhase,
} from "../lib/voiceInput/composer";
import { requestVoiceInputConsent } from "../lib/voiceInput/consent";
import {
  applyVoiceInputPartial,
  beginVoiceInputDraft,
  finishVoiceInputDraft,
  revertVoiceInputDraft,
  type VoiceInputDraft,
  type VoiceInputDraftUpdate,
} from "../lib/voiceInput/draft";
import { glowVoiceInputText } from "../lib/voiceInput/glow";
import { useComposerVoiceInput } from "./useComposerVoiceInput";
import { useVoiceInputRemaining } from "./useVoiceInputRemaining";

/** 所有領域を手入力で失くしたときの注記。確定テキストを入れない理由を 1 行で伝える */
const VOICE_INPUT_DRAFT_EDITED_NOTICE = "下書きを編集したため、確定したテキストは反映していません。";

/**
 * 送信の直後に主スロットの入れ替えを保留する時間。本文を消した描画で ↑ が ■ へ変わると、1 回目の
 * クリックの続き (二度押し / ダブルタップ) がそのまま停止に届き、走っている実行と待機キューが落ちる
 */
const STOP_PROMOTION_HOLD_MS = 500;

export type ComposerVoiceDraftOptions = {
  /** 拡大しても同じ textarea。現在の選択範囲を読み、反映後のカーソルと焦点を戻す */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 現在の本文。state の反映を待たずに前の本文と比べるため、呼び出し側の写しを読む */
  readBody: () => string;
  /** 本文の置き換え。呼び出し側の写しも同じ描画で最新にする */
  replaceBody: (next: string) => void;
  /** 初回の録音で 1 度だけ出す確認 */
  confirm: ConfirmFn;
  /** 確認ダイアログに出す固定モデル名 */
  model: string;
  /** 会話の切替キー。変わったら録音を中断し、確定待ちの本文を次の会話へ持ち越さない */
  scope: string | undefined;
  /** 非表示 (設定ページ) の間は録音を続けない */
  visible: boolean;
  /** 音声の操作中の phase。再実行 / 未送信の再送を呼び出し側が止める根拠 */
  onPhaseChange?: (phase: VoiceInputComposerPhase) => void;
};

export type ComposerVoiceDraft = {
  phase: VoiceInputComposerPhase;
  /** 送信と再実行を止める理由。止めないときは undefined */
  blockedReason: string | undefined;
  /** マイクを隠す間 (接続中 / 録音中 / 確定待ち) */
  busy: boolean;
  /** 操作の終了直後。主スロットの入れ替えを保留している間 */
  hold: boolean;
  /** 確定テキストを入れられなかった理由。会話の notice と同じ行に出す */
  notice: string | null;
  /** 送信で下書きを消したときに、音声由来の注記も外す */
  clearNotice: () => void;
  /** 残り時間の割合 (1 → 0)。弧の角度だけに使う */
  remaining: number;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

/**
 * 録音 1 回分の本文への反映。開始時のカーソル / 選択を基準にした所有領域 (`lib/voiceInput/draft.ts`) を
 * 途中文と確定テキストで差し替え、取消で開始前へ戻す。本文は持たず、呼び出し側と「本文を読む」
 * 「本文を置き換える」だけでやり取りする。焦点の復帰と演出、終了直後の保留もここに閉じる。
 */
export function useComposerVoiceDraft({
  inputRef,
  readBody,
  replaceBody,
  confirm,
  model,
  scope,
  visible,
  onPhaseChange,
}: ComposerVoiceDraftOptions): ComposerVoiceDraft {
  const voice = useComposerVoiceInput();
  const { state: voiceState, start: startVoice, stop: stopVoice, cancel: cancelVoice } = voice;
  // 音声由来の注記 (確定文を入れられなかった理由など)
  const [notice, setNotice] = useState<string | null>(null);
  // 所有領域 (開始時のカーソル / 選択を基準に、システムが差し替えてよい範囲)
  const draftRef = useRef<VoiceInputDraft | null>(null);
  // 録音を始めたときの焦点。確定後に焦点を戻すかの判定に使う (利用者が別の場所へ移っていたら奪わない)
  const focusRef = useRef<Element | null>(null);
  // 途中の文字を光らせている最中の演出。次の途中文と取消で切る
  const glowRef = useRef<Animation | null>(null);
  // 途中文で本文が変わった回数。描画の後に光らせる合図で、0 は未開始
  const [glowCount, setGlowCount] = useState(0);
  // 確認を開いている間に会話が変わったかを見る基準（戻ってきたら、別の会話の下書きへ録音を始めない）
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 音声の操作が終わった直後の保留 (送信直後の停止の保留と同じ理由)。取消 / 確定で主スロットが
  // 入れ替わった位置を続けて押すと、そのまま送信へ届いてしまう
  const [hold, setHold] = useState(false);
  const phaseRef = useRef(voiceState.phase);
  useEffect(() => {
    const previous = phaseRef.current;
    phaseRef.current = voiceState.phase;
    if (previous === "idle" || voiceState.phase !== "idle") return;
    setHold(true);
    const timer = window.setTimeout(() => setHold(false), STOP_PROMOTION_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [voiceState.phase]);

  /** 所有領域の更新を本文へ反映する。カーソルは入力欄が焦点を持っているときだけ戻す */
  const applyVoiceDraft = useCallback(
    (update: VoiceInputDraftUpdate) => {
      draftRef.current = update.draft;
      if (update.value !== readBody()) replaceBody(update.value);
      if (update.caret === null) return;
      const caret = update.caret;
      // コールバックは再描画をまたいで届くので、本文を書き換えた後の選択を描画後に戻す
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || el.ownerDocument.activeElement !== el) return;
        el.setSelectionRange(caret, caret);
      });
    },
    [inputRef, readBody, replaceBody],
  );

  // 光らせるのは新しい文字が DOM に入った後にする。同じ呼び出しで始めると描画の前に演出が走り、
  // 最初の途中文ではプレースホルダが光る
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (glowCount === 0 || el === null) return;
    glowRef.current = glowVoiceInputText(el, glowRef.current);
  }, [glowCount, inputRef]);

  /** 取消・失敗。所有領域だけを開始前へ戻す（開始後の手入力は巻き戻さない） */
  const handleCancel = useCallback(() => {
    const draft = draftRef.current;
    draftRef.current = null;
    focusRef.current = null;
    glowRef.current?.cancel();
    glowRef.current = null;
    if (draft === null) return;
    applyVoiceDraft(revertVoiceInputDraft(draft, readBody()));
  }, [applyVoiceDraft, readBody]);

  /**
   * 確定。所有を失っていれば本文を変えず、残った途中文と確定テキストの重複を作らない。
   * 入れたときはカーソルを確定テキストの直後へ戻し、焦点を入力欄へ返す。
   */
  const handleFinal = useCallback(
    (text: string) => {
      const draft = draftRef.current;
      draftRef.current = null;
      const focused = focusRef.current;
      focusRef.current = null;
      if (draft === null) return;
      const update = finishVoiceInputDraft(draft, readBody(), text);
      if (!update.applied) {
        if (update.draft.status === "detached") setNotice(VOICE_INPUT_DRAFT_EDITED_NOTICE);
        return;
      }
      replaceBody(update.value);
      const caret = update.caret;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el || caret === null) return;
        const active = el.ownerDocument.activeElement;
        // 利用者が別の場所を操作していたら焦点を奪わない（録音中に別の面へ移った場合だけ戻さない）
        if (active === el || active === el.ownerDocument.body || active === focused) el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [inputRef, readBody, replaceBody],
  );

  /** マイク。初回だけ確認を出し、承諾したら開始時のカーソル / 選択を控えて録音を始める */
  const start = useCallback(() => {
    void (async () => {
      const startedScope = scopeRef.current;
      const allowed = await requestVoiceInputConsent({
        storage: deviceSettingsStorage(),
        confirm,
        model,
      });
      if (!allowed) return;
      // 確認を開いている間に会話が変わっていたら、その会話の下書きへは始めない
      if (scopeRef.current !== startedScope) return;
      const el = inputRef.current;
      const current = readBody();
      const caret = el?.selectionStart ?? current.length;
      draftRef.current = beginVoiceInputDraft(current, caret, el?.selectionEnd ?? current.length);
      focusRef.current = document.activeElement;
      setNotice(null);
      startVoice({
        onPartial: (text) => {
          const draft = draftRef.current;
          if (draft === null) return;
          const previous = readBody();
          const at = inputRef.current?.selectionStart ?? previous.length;
          const update = applyVoiceInputPartial(draft, previous, text, at);
          applyVoiceDraft(update);
          // 文字が変わらなかった途中文では光らせない（同じ文が続くと、光りっぱなしに見える）
          if (update.applied && update.value !== previous) setGlowCount((count) => count + 1);
        },
        onFinal: handleFinal,
        onCancel: handleCancel,
        onError: (failure) => {
          handleCancel();
          setNotice(`音声入力を続けられませんでした（${failure.message}）`);
        },
      });
    })();
  }, [applyVoiceDraft, confirm, handleCancel, handleFinal, inputRef, model, readBody, startVoice]);

  // 設定・実行状況へ移るときは録音を続けない（非表示の面でマイクを握ったままにしない）
  useEffect(() => {
    if (!visible) cancelVoice();
  }, [visible, cancelVoice]);

  // 会話の切替（添付が暗黙に作った会話への移動を含む）でも中断する。確定テキストが次の会話の下書きへ混ざらない
  useEffect(() => {
    cancelVoice();
    setNotice(null);
  }, [scope, cancelVoice]);

  // 再実行 / 未送信の再送を呼び出し側が止められるよう、音声の操作中の phase を知らせる
  const notifyPhase = useRef(onPhaseChange);
  notifyPhase.current = onPhaseChange;
  useEffect(() => {
    notifyPhase.current?.(voiceState.phase);
  }, [voiceState.phase]);
  useEffect(() => () => notifyPhase.current?.("idle"), []);

  // 残り時間の弧。期限まで 1 秒刻みで描き直す (録音中だけ時計を進める)
  const remaining = useVoiceInputRemaining(voiceState.deadline, voiceState.startedAt);
  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    phase: voiceState.phase,
    blockedReason: voiceInputComposerBlockedReason(voiceState.phase),
    busy: voiceInputComposerBusy(voiceState.phase),
    hold,
    notice,
    clearNotice,
    remaining,
    start,
    stop: stopVoice,
    cancel: cancelVoice,
  };
}
