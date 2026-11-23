/**
 * 音声入力の未確定領域。録音を始めた時点のカーソル / 選択範囲を基準に、システムが差し替えてよい範囲だけを持つ。
 * 範囲の外の手入力は消さず、境界を含む編集で所有が切れたら以降は本文へ触らない
 * （残った途中文と確定文を並べると、同じ発話が二重に入る）。DOM を知らない純関数だけを置く。
 */

/** `open` だけが領域を差し替えてよい。`detached` は手入力で所有を失った、`settled` は確定 / 取消が済んだ */
export type VoiceInputDraftStatus = "open" | "detached" | "settled";

export type VoiceInputDraft = {
  /** 所有領域の開始位置 */
  start: number;
  /** 所有領域の終了位置 */
  end: number;
  /** 所有領域へ入れた文字（直前の本文と突き合わせて、手入力が入っていないかを見る） */
  text: string;
  /** 直前に画面へ反映した本文 */
  body: string;
  /** 開始時に選択していた文字（取消で戻す） */
  selected: string;
  status: VoiceInputDraftStatus;
};

export type VoiceInputDraftUpdate = {
  draft: VoiceInputDraft;
  /** 反映後の本文。変更しなかったときは受け取った本文のまま */
  value: string;
  /** 入力欄へ戻すカーソル。本文を変えなかったときは null（呼び出し側は選択を触らない） */
  caret: number | null;
  /** 所有領域を置き換えたか */
  applied: boolean;
};

const clamp = (position: number, max: number): number => Math.min(Math.max(position, 0), max);

/**
 * 録音の開始時に 1 度だけ作る。選択範囲があればその範囲を置き換え、取消ではその文字を戻す。
 * 選択が無ければカーソル位置へ挿入する。
 */
export function beginVoiceInputDraft(value: string, selectionStart: number, selectionEnd: number): VoiceInputDraft {
  const start = clamp(Math.min(selectionStart, selectionEnd), value.length);
  const end = clamp(Math.max(selectionStart, selectionEnd), value.length);
  return { start, end, text: "", body: value, selected: value.slice(start, end), status: "open" };
}

/** 直前の本文からの差分。同じ 1 点への挿入は幅 0 の編集として返す */
type BodyEdit = { start: number; end: number; delta: number };

function bodyEdit(body: string, value: string): BodyEdit | null {
  if (body === value) return null;
  const limit = Math.min(body.length, value.length);
  let prefix = 0;
  while (prefix < limit && body[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && body[body.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
  return { start: prefix, end: body.length - suffix, delta: value.length - body.length };
}

/**
 * 手入力が所有領域のどこに入ったか。`before` は領域が右へずれる、`after` は領域が動かない、
 * `overlap` は所有を失う（位置を信用できない）。
 */
type EditPlacement = "none" | "before" | "after" | "overlap";

/**
 * 手入力の位置を 1 回だけ決める。領域の開始・終了ちょうどへの挿入も「境界を含む編集」として拾うため、
 * 幅 0 の差分（挿入）だけは向きの判定を 1 文字分きつくする。
 */
function editPlacement(draft: VoiceInputDraft, edit: BodyEdit | null): EditPlacement {
  if (edit === null) return "none";
  const insertion = edit.end === edit.start;
  if (insertion ? edit.end < draft.start : edit.end <= draft.start) return "before";
  if (insertion ? edit.start > draft.end : edit.start >= draft.end) return "after";
  return "overlap";
}

/**
 * 領域の位置。ずらすのは手入力が領域より前にあるときだけ。後ろの編集でもずらすと、次の部分テキストが
 * 利用者の文字の上を置き換え、取消ではその文字ごと消える（領域の中身と位置がずれる）。
 */
function shifted(draft: VoiceInputDraft, edit: BodyEdit | null, placement: EditPlacement): VoiceInputDraft {
  if (edit === null || placement !== "before" || edit.delta === 0) return draft;
  return { ...draft, start: draft.start + edit.delta, end: draft.end + edit.delta };
}

/** 手入力の位置を 1 回だけ決め、領域の位置を返す。所有を失っていれば `detached` */
function settleRegion(draft: VoiceInputDraft, value: string): { region: VoiceInputDraft; detached: boolean } {
  const edit = bodyEdit(draft.body, value);
  const placement = editPlacement(draft, edit);
  if (placement === "overlap") return { region: draft, detached: true };
  return { region: shifted(draft, edit, placement), detached: false };
}

function detach(draft: VoiceInputDraft, value: string): VoiceInputDraftUpdate {
  return { draft: { ...draft, status: "detached" }, value, caret: null, applied: false };
}

/**
 * 領域を置き換えた後のカーソル。領域より前はそのまま、後ろは増減分だけずらす。
 * 領域の先頭にいた場合は挿入した文字の末尾へ送る（書き続けても境界を触らないようにする）。
 */
function caretAfterReplace(caret: number, start: number, end: number, length: number): number {
  if (caret < start) return caret;
  const shifted = caret + length - (end - start);
  return Math.max(start, Math.min(shifted, start + length));
}

/**
 * 途中の文字起こしを所有領域へ入れる。手入力が入っていれば本文を変えずに所有を切る
 * （部分文本を消すと、利用者がその中へ書いた文字まで消える）。
 */
export function applyVoiceInputPartial(
  draft: VoiceInputDraft,
  value: string,
  partial: string,
  caret: number = value.length,
): VoiceInputDraftUpdate {
  if (draft.status !== "open") return { draft, value, caret: null, applied: false };
  const settled = settleRegion(draft, value);
  if (settled.detached) return detach(draft, value);
  const region = settled.region;
  const next = `${value.slice(0, region.start)}${partial}${value.slice(region.end)}`;
  return {
    draft: { ...region, end: region.start + partial.length, text: partial, body: next },
    value: next,
    caret: caretAfterReplace(caret, region.start, region.end, partial.length),
    applied: true,
  };
}

/**
 * 確定テキストを所有領域へ入れる。所有を失っていれば本文は変えず `applied: false` を返し、
 * 呼び出し側は確定テキストを捨てて案内だけを出す。確定済みの draft へもう一度呼んでも本文は変わらない。
 */
export function finishVoiceInputDraft(
  draft: VoiceInputDraft,
  value: string,
  text: string,
  caret: number = value.length,
): VoiceInputDraftUpdate {
  if (draft.status !== "open") return { draft, value, caret: null, applied: false };
  const settled = settleRegion(draft, value);
  if (settled.detached) return detach(draft, value);
  const region = settled.region;
  const next = `${value.slice(0, region.start)}${text}${value.slice(region.end)}`;
  return {
    draft: { ...region, status: "settled", end: region.start + text.length, text, body: next },
    value: next,
    caret: caretAfterReplace(caret, region.start, region.end, text.length),
    applied: true,
  };
}

/**
 * 取消・失敗で所有領域だけを開始前へ戻す。開始時に選択していた文字があればその文字を戻し、
 * 開始後の手入力は巻き戻さない（所有を失っていれば本文には触らない）。
 */
export function revertVoiceInputDraft(draft: VoiceInputDraft, value: string): VoiceInputDraftUpdate {
  if (draft.status !== "open") return { draft, value, caret: null, applied: false };
  const settled = settleRegion(draft, value);
  if (settled.detached) return detach(draft, value);
  const region = settled.region;
  const next = `${value.slice(0, region.start)}${region.selected}${value.slice(region.end)}`;
  return {
    draft: {
      ...region,
      status: "settled",
      end: region.start + region.selected.length,
      text: region.selected,
      body: next,
    },
    value: next,
    caret: region.start + region.selected.length,
    applied: true,
  };
}
