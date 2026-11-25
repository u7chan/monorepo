import { CollapsibleNotice } from "../CollapsibleNotice";

/** キーを暗号化して保存することと、BFF を公開しない注意。詳細の上部に既定で畳んで出す */
export function SecurityNotice() {
  return (
    <CollapsibleNotice summary="キーは暗号化して保存されます。ログインがないため公開しないでください。">
      <p>
        登録したキーは暗号化してアプリのデータベース（SQLite）へ保存され、再起動後も使われます。保存したキーは再表示しません。
        master key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は、保存済みのキーを使えません。
      </p>
      <p>この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。</p>
      <p>キーの有効性は保存時に確認しません。生成に失敗したときは、キーの誤りや残高不足の可能性があります。</p>
    </CollapsibleNotice>
  );
}
