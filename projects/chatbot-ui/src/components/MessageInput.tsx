import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";

interface MessageInputProps {
  onSendMessage: (message: string) => void;
}

export function MessageInput({ onSendMessage }: MessageInputProps) {
  // 入力メッセージの状態管理
  const [inputMessage, setInputMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [composition, setComposition] = useState(false);

  // テキストエリアの高さを調整する（5行まで自動拡張、それ以上はスクロール）
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      // 入力が完全に空の場合のみ最小の高さに設定
      if (inputMessage === "") {
        textarea.style.height = "36px"; // min-h-[36px]と同じ値
        textarea.style.overflowY = "hidden";
      } else {
        // 行数を計算（改行の数+1）
        const lineCount = (inputMessage.match(/\n/g) || []).length + 1;

        // 5行までは自動拡張（1行あたり約24px）
        const newHeight = Math.min(textarea.scrollHeight, 5 * 24);
        textarea.style.height = `${newHeight}px`;

        // 5行以下ならスクロールバーを非表示、それ以上ならスクロールバーを表示
        textarea.style.overflowY = lineCount <= 5 ? "hidden" : "auto";
      }
    }
  }, [inputMessage]); // inputMessageが変更されたときに高さを調整

  const handleChangeComposition = (composition: boolean) => {
    setComposition(composition);
  };

  // メッセージ送信処理
  const handleSendMessage = () => {
    if (!inputMessage.trim() || composition) {
      return;
    }
    onSendMessage(inputMessage);
    setInputMessage("");
  };

  return (
    <div className="border-t p-4 bg-card">
      <div className="container mx-auto max-w-4xl">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage();
          }}
        >
          <Textarea
            ref={textareaRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onCompositionStart={() => handleChangeComposition(true)}
            onCompositionEnd={() => handleChangeComposition(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) {
                  // Shift+Enterの場合は常に改行を許可
                  return;
                }
                // 通常のEnterはメッセージ送信
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 min-h-[36px] max-h-[120px]"
            rows={1}
          />
          <Button type="submit" disabled={!inputMessage.trim()}>
            送信
          </Button>
        </form>
      </div>
    </div>
  );
}
