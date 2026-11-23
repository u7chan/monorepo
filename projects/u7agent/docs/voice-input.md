# 音声入力の録音と文字起こし

録音 1 回分の接続・期限・終了の扱いをまとめる。ブラウザ側の状態機械は `client/src/lib/voiceInput/session.ts`、
画面の状態は `client/src/lib/voiceInput/playground.ts`、Realtime セッションの中継は
[api-settings.md](api-settings.md#音声入力の-realtime-中継) を正とする。

## 接続

設定 → 音声入力（`/settings/voice-input`）のプレイグラウンドは、マイクを取って offer SDP を作り、
`POST /api/voice-input/session` へ送って answer SDP を受ける。音声と文字起こしのイベントはブラウザと OpenAI の間で
WebRTC を通り、BFF は SDP を中継するだけで音声も文字起こしも持たない。ブラウザが外部オリジンへ直接 POST しないため、
CSP の `connect-src` は `'self'` のままにする（[api-settings.md](api-settings.md#音声入力の-realtime-中継) の
「CSP を緩めない理由」）。

## 期限の強制

録音の上限は固定で、正は `client/src/lib/voiceInput/session.ts`。上限は手動停止にも適用し、上限に達したら音声の送信を
止めてマイクを解放し、確定を要求する。

`RTCRtpScriptTransform` を持つブラウザでは、`client/src/workers/voiceAudioDeadline.ts` が期限後の音声フレームを
送信側で落とす。worker は同一オリジンの別チャンクとして配信し、`blob:` を作らない（CSP の `script-src` を
緩めないため）。

- `RTCRtpScriptTransform` を持たないブラウザでも録音は成立させ、期限の強制だけを諦める。この場合の期限は画面側の
  タイマーによる `track.stop()` だけになる
- transform の API はあるのに worker / transform の起動に失敗した場合は、期限を守れない録音を黙って続けず中止する
  （失敗の分類は `audio-filter`）
- **既知の制限**: 期限の強制を持たないブラウザで画面が固まると、上限を過ぎた音声が送られうる。プレイグラウンドは
  この制限を表示する

## 終了の条件

手動停止・上限による自動停止・キャンセル・プレイグラウンドを閉じる・設定を離れる・`pagehide` のどれでも、マイク・
peer・worker・タイマーを閉じる。停止後はマイクを止めてから commit を送る（音声と制御は別経路なので、同時に送ると
末尾の音声を追い越す）。録音には世代を持ち、キャンセル後に届いたコールバックは状態を変えない。

## 保存しないこと

音声も途中・確定の文字起こしも保存しない（履歴を持たない）。プレイグラウンドは確定テキストを読取専用で表示するだけで、
入力欄へは入れない。金額の概算と言語の指定もしない。課金は、残高不足（上流の 402 に対応する分類）だけを文言に使い、
金額は表示しない。
