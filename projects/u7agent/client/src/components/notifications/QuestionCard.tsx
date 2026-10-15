import { ToggleSwitch } from "../ToggleSwitch";
import { NotificationCard } from "./NotificationCard";

export type QuestionCardProps = {
  askUser: boolean;
  onChangeAskUser: (askUser: boolean) => void;
};

/** 質問の通知。会話ごとの通知トグルとは独立に、質問が発生したことだけを送るかどうかを決める */
export function QuestionCard({ askUser, onChangeAskUser }: QuestionCardProps) {
  return (
    <NotificationCard
      title="質問の通知"
      action={<ToggleSwitch checked={askUser} label={askUser ? "有効" : "無効"} onChange={onChangeAskUser} />}
    >
      <p className="text-2xs leading-relaxed text-ink-ghost">
        エージェントが ask_user で質問したときに、回答待ちが始まったことを 1 通だけ送ります。会話の通知が Off
        の会話でも、質問が発生したことと会話のリンクは届きます（タイトルと質問文は載りません）。
      </p>
    </NotificationCard>
  );
}
