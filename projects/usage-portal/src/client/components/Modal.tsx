import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * ネイティブの `<dialog>` をモーダルとして開く。フォーカスの閉じ込め、背景の不活性化、Esc はブラウザに任せる。
 * 背景のクリックでは閉じない。入力中の API キーを誤タップで捨てないため。
 */
export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;

    if (element && !element.open) {
      element.showModal();
    }

    // 開いたまま要素を外すと背景の不活性化が残ることがあるため、閉じてから片付ける。
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
        // ブラウザに閉じさせると親の状態と食い違うので、閉じる処理は親に寄せる。
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class="up-dialog-body">
        <h2 class="up-subheading" id="up-dialog-title">
          {props.title}
        </h2>
        {props.children}
      </div>
    </dialog>
  );
}
