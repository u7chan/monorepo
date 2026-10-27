import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * ネイティブの `<dialog>` をモーダルとして開く。フォーカスの閉じ込め、背景の不活性化、Esc はブラウザに任せる。
 * 背景のクリックでは閉じない。入力中の API キーを誤タップで捨てないため。
 */
export function Modal(props: {
  title: string;
  /** 閉じる処理は children に渡す `close` を使う。DOM を外す前に `close()` を通すため。 */
  onClose: () => void;
  children: (close: () => void) => ComponentChildren;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  const close = (): void => {
    // ネイティブの close() は、開く前にフォーカスがあった要素へ戻す。
    // DOM を外してからでは戻せない（unmount 後の close() では isConnected が false）ので、外す前に呼ぶ。
    if (dialog.current?.open) {
      dialog.current.close();
    }

    props.onClose();
  };

  useEffect(() => {
    const element = dialog.current;

    if (element && !element.open) {
      element.showModal();
    }

    // close を通らない経路で外れたときの後始末。ここではフォーカスは戻らない。
    return () => {
      if (element?.open) {
        element.close();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      class="up-dialog"
      aria-labelledby="up-dialog-title"
      onCancel={(event) => {
        // ブラウザに閉じさせず、フォーカスを戻す経路へ寄せる。
        event.preventDefault();
        close();
      }}
    >
      <div class="up-dialog-body">
        <h2 class="up-subheading" id="up-dialog-title">
          {props.title}
        </h2>
        {props.children(close)}
      </div>
    </dialog>
  );
}
