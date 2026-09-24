import type { ReactNode } from "react";

/** 通知設定のカードの外装。見出しの右に操作 (有効トグルなど) を置ける。見た目はここ 1 箇所が持つ */
export function NotificationCard({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
