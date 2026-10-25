export function SessionExpiryBanner(props: { remaining: string; onRelogin: () => void }) {
  // ページを開いた時点で一度だけ読み上げる。閉じるボタンは付けず、期限が近い間は出し続ける。
  return (
    <div class="up-banner" role="status">
      <p class="up-caption">ログインの有効期限が近づいています（あと {props.remaining}）</p>
      <button class="up-button" type="button" onClick={props.onRelogin}>
        PIN を再入力
      </button>
    </div>
  );
}
