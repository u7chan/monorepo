import { useMessageCopy } from "../hooks/useMessageCopy";
import { qrCodeModules, qrCodePath, qrCodeViewSize } from "../lib/qrCode";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "./icons";

/**
 * URL の QR コードと、読み取れない端末・スクリーンリーダーのための URL のテキスト・開く・コピー。
 * QR を唯一の経路にしないため併置する。共有物の QR ダイアログと一時共有が同じ契約で使う。
 */
export function QrCodeView({ url }: { url: string }) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const qr = qrCodeModules(url);
  const viewSize = qr === null ? 0 : qrCodeViewSize(qr.size);
  const copied = copiedId === url;

  return (
    <>
      {qr === null ? (
        <p className="text-xs break-words text-warn-text">
          QR コードを作れませんでした。下の URL をコピーして渡してください。
        </p>
      ) : (
        <svg
          role="img"
          aria-label="公開 URL の QR コード"
          viewBox={`0 0 ${viewSize} ${viewSize}`}
          shapeRendering="crispEdges"
          className="mx-auto size-40 shrink-0"
        >
          {/* 白地 + 黒の固定配色。テーマのトークンだとダークテーマで反転し、カメラが読めない */}
          {/* oxlint-disable-next-line shadcn/no-raw-colors -- QR の読み取りには固定色が要る */}
          <rect width={viewSize} height={viewSize} fill="#ffffff" />
          {/* oxlint-disable-next-line shadcn/no-raw-colors -- QR の読み取りには固定色が要る */}
          <path d={qrCodePath(qr.modules)} fill="#000000" />
        </svg>
      )}

      <code className="block rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-2xs break-all text-ink-soft select-all">
        {url}
      </code>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <a href={url} target="_blank" rel="noreferrer noopener" className="btn-quiet singleColumn:min-h-11">
          <ExternalLinkIcon />
          開く
        </a>
        <button
          type="button"
          onClick={() => {
            void copyMessage(url, url);
          }}
          className="btn-quiet singleColumn:min-h-11"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "コピーしました" : "URL をコピー"}
        </button>
      </div>

      {copyFailure(url) === undefined ? null : (
        <p role="alert" className="text-2xs break-words text-danger-text">
          コピーできませんでした。URL を選択してコピーしてください。
        </p>
      )}
    </>
  );
}
