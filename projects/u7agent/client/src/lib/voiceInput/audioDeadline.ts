/**
 * 期限を過ぎた音声フレームを捨てる処理。期限の強制は、期限後に届いたフレームを送信側で落とすことで行う。
 * 時計を引数で受けるので、worker（`client/src/workers/voiceAudioDeadline.ts`）と Node のテストが同じ実装を使う。
 */
export function audioBeforeDeadline(deadline: () => number, now: () => number): TransformStream<unknown, unknown> {
  return new TransformStream({
    transform(frame, output) {
      if (now() < deadline()) output.enqueue(frame);
    },
  });
}

/**
 * worker 側の時計。期限は main thread の絶対時刻で受け取るため、同じ基準へ揃える
 * （dedicated worker の time origin は開いた文書のもの）。
 */
export function audioDeadlineClock(): () => number {
  return () => performance.timeOrigin + performance.now();
}
