import { getStatusTone, type StatusTone } from "../../lib/containerState";
import type { Container } from "../../types/container";

const TONE_DOT: Record<StatusTone, string> = {
  live: "bg-live",
  warn: "bg-warn",
  dead: "bg-dead",
  info: "bg-info",
  idle: "bg-label-3",
};

const TONE_TEXT: Record<StatusTone, string> = {
  live: "text-live",
  warn: "text-warn",
  dead: "text-dead",
  info: "text-info",
  idle: "text-label-2",
};

/**
 * ステータス表示。色だけで意味を運ばないよう、必ず Docker の状態文言も添える。
 * "Up 3 days" のような人間向け文言を優先し、空のときだけ state に落とす。
 */
function StatusLabel({ container }: { container: Container }) {
  const tone = getStatusTone(container.state);
  const label = container.status || container.state;

  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-subhead">
      <span
        aria-hidden="true"
        className={["mt-[0.4375rem] size-2 shrink-0 rounded-full", TONE_DOT[tone]].join(" ")}
      />
      <span className={["min-w-0 [overflow-wrap:anywhere]", TONE_TEXT[tone]].join(" ")}>
        {label}
      </span>
    </p>
  );
}

/**
 * 名前と状態。名前は省略せず折り返す。長い名前を 1 行に押し込むと、末尾の違い
 * (-production と -staging など) が読めなくなる。
 */
export function ContainerHeading({ container }: { container: Container }) {
  return (
    <div className="min-w-0 flex-1 basis-[9rem]">
      <h3
        className="text-headline font-semibold [overflow-wrap:anywhere] text-label"
        title={container.name}
      >
        {container.name}
      </h3>
      <StatusLabel container={container} />
    </div>
  );
}
