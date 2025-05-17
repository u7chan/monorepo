import { useState } from "react";
import { MessageInput } from "#/components/MessageInput";
import { MessageArea, type Message } from "#/components/MessageArea";
import { Header } from "#/components/Header";

export function App() {
  // メッセージの状態管理
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      content: "こんにちは！何かお手伝いできることはありますか？",
      sender: "bot",
      timestamp: new Date(),
    },
  ]);

  // メッセージ送信処理
  const handleSendMessage = (message: string) => {
    // ユーザーメッセージを追加
    const userMessage: Message = {
      id: Date.now().toString(),
      content: message,
      sender: "user",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);

    // ボットの応答を追加（実際のアプリではAPIリクエストなどが入る）
    setTimeout(() => {
      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        content: "ご質問ありがとうございます。どのようにお手伝いできますか？",
        sender: "bot",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, botMessage]);
    }, 1000);
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* ヘッダー */}
      <Header />

      {/* メッセージエリア */}
      <MessageArea messages={messages} />

      {/* 入力エリア */}
      <MessageInput onSendMessage={handleSendMessage} />
    </div>
  );
}
