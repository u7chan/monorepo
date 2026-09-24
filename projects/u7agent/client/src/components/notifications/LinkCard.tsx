import { NotificationCard } from "./NotificationCard";

export type LinkCardProps = {
  value: string;
  onChange: (baseUrl: string) => void;
};

/** 通知に載せるリンクのベース URL。空ならリンク行ごと出さない (サーバーの契約と同じ) */
export function LinkCard({ value, onChange }: LinkCardProps) {
  return (
    <NotificationCard title="リンク">
      <div className="grid gap-1">
        <span className="text-2xs text-ink-soft">通知から会話を開く URL のベース</span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field min-w-0 flex-1 text-xs"
            type="text"
            value={value}
            placeholder="http://127.0.0.1:5173"
            aria-label="通知から会話を開く URL のベース"
            autoComplete="off"
            spellCheck={false}
            // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
            onChange={(event) => {
              const next = event.currentTarget.value;
              onChange(next);
            }}
          />
          <button type="button" className="btn-quiet" onClick={() => onChange(location.origin)}>
            今開いている URL を使う
          </button>
        </div>
      </div>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        空にするとリンクを載せません。127.0.0.1 のリンクは同じ端末のブラウザでだけ開けます（認証がないアプリなので、LAN
        / インターネットへ公開しないでください）。
      </p>
    </NotificationCard>
  );
}
