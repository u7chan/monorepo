import { cn } from "../../lib/cn";

/** Model / Effort の select で同じ見た目を共有する (片方だけ変わると行が揃わない) */

/** popover では 2 行を縦に積む。名前の幅を固定し、名前の長さで select の左端がずれないようにする */
export const fieldLabelClass = cn("flex min-w-0 items-center gap-2 text-2xs text-ink-faint");

export const fieldNameClass = cn("w-12 shrink-0 tracking-wide uppercase");

/**
 * コンポーザーのエージェント欄の外枠と箱。選べるプルダウン (`AgentPicker`) とセッション中のラベル
 * (`AgentLabel`) が共有する (最初の送信で入れ替わるときに欄の幅と高さを動かさない)。
 */
export const agentFrameClass = (compact: boolean): string =>
  cn("relative inline-flex min-w-0 items-center", compact ? "min-w-0 flex-1" : "max-w-50 min-w-0");

export const agentBoxClass = (compact: boolean): string =>
  cn("field grid w-full py-1 pr-8 pl-6.5 text-left", compact ? "text-md" : "text-1xs");

/**
 * セッション中のラベルは選び直せないので、箱の寸法だけ借りて枠と塗りは出さない (入力欄の見た目にしない)。
 * `border-0` で消すと 2px 縮んで最初の送信で行が動くため透明な色で消し、文字色は `text-ink` から落とす。
 */
export const agentLabelBoxClass = (compact: boolean): string =>
  cn(agentBoxClass(compact), "border-transparent bg-transparent text-ink-soft");
