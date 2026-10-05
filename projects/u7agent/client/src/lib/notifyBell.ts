/**
 * 通知ベルの演出 (押して On にした瞬間だけ一度鳴らす) の状態遷移。DOM に依存しない形に切り出し、
 * 「On の値が上がっただけでは鳴らない」ことをテストで固定する (会話の切替 / リロード / deep link の
 * 解決でも、選択中の会話の値は On へ上がる)。
 */
export type NotifyBellState = {
  /** 最後に鳴らした世代。トグルを押して On にしたときだけ親が進める */
  played: number;
  /** 演出中か */
  ringing: boolean;
};

/** 初回の描画では鳴らさない (On の会話を開き直しただけの状態から始まる) */
export function initialNotifyBellState(ring: number): NotifyBellState {
  return { played: ring, ringing: false };
}

/**
 * props (ring / on) と演出の終了から次の状態を決める。`on` が true でも世代が同じなら鳴らさない。
 * 変化が無いときは同じオブジェクトを返し、呼び出し側が再描画の要否を判定できるようにする。
 */
export function nextNotifyBellState(
  state: NotifyBellState,
  input: { ring: number; on: boolean; finished: boolean },
): NotifyBellState {
  if (!input.on) return state.ringing ? { ...state, ringing: false } : state;
  if (state.played !== input.ring) return { played: input.ring, ringing: true };
  if (state.ringing && input.finished) return { ...state, ringing: false };
  return state;
}
