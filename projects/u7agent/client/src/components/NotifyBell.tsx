import { useState } from "react";
import { cn } from "../lib/cn";
import { BellGlyph } from "./icons";

/** 4 方向へ尖るきらめき。中心を制御点にした 2 次曲線でくぼませ、菱形の点に見せない */
function sparklePath(cx: number, cy: number, radius: number): string {
  const top = cy - radius;
  const right = cx + radius;
  const bottom = cy + radius;
  const left = cx - radius;
  return `M${cx} ${top} Q${cx} ${cy} ${right} ${cy} Q${cx} ${cy} ${cx} ${bottom} Q${cx} ${cy} ${left} ${cy} Q${cx} ${cy} ${cx} ${top} Z`;
}

/**
 * 会話の通知トグルのベル。Off → On になった瞬間だけ一度鳴る (揺れ・音の輪・きらめき)。
 * 立ち上がりに限るのは、On の会話を開き直した / リロードした / 別の会話へ移っただけで鳴ると、
 * 押していない操作に反応して見えるため。静止した状態印は BellIcon のままにする。
 */
export function NotifyBell({ ringing }: { ringing: boolean }) {
  const [ring, setRing] = useState(false);
  const [wasRinging, setWasRinging] = useState(ringing);

  // props の変化を描画中に見て state を調整する (effect だと演出の開始が 1 コミット遅れる)
  if (wasRinging !== ringing) {
    setWasRinging(ringing);
    setRing(ringing && !wasRinging);
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      // 音の輪ときらめきは viewBox の外まで広がる。切り取らず、隣の操作を邪魔しない
      className={cn("pointer-events-none size-4 shrink-0 overflow-visible", ring && "notify-bell-ring")}
      // 根の pop の終了 = 一連の終わり。子 (音の輪・きらめき) の終了では切らない
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setRing(false);
      }}
    >
      {ring ? (
        <g className="pointer-events-none">
          {/* 音の輪。中心をベル (8, 10.3) に揃えた同心の弧で、左右とも外向きへ膨らむ */}
          <path className="notify-bell-wave notify-bell-wave-left" d="M3.5 7.7A5.2 5.2 0 0 0 3.5 12.9" />
          <path
            className="notify-bell-wave notify-bell-wave-left notify-bell-step-1"
            d="M2.05 7A6.8 6.8 0 0 0 2.05 13.6"
          />
          <path className="notify-bell-wave notify-bell-wave-right" d="M12.5 7.7A5.2 5.2 0 0 1 12.5 12.9" />
          <path
            className="notify-bell-wave notify-bell-wave-right notify-bell-step-1"
            d="M13.95 7A6.8 6.8 0 0 1 13.95 13.6"
          />
          {/* きらめきはベルの上に散らす (鳴っている印の線と重ならない位置) */}
          <path className="notify-bell-sparkle" d={sparklePath(7.6, 1.6, 1.2)} fill="currentColor" stroke="none" />
          <path
            className="notify-bell-sparkle notify-bell-step-1"
            d={sparklePath(11, 3.2, 1.6)}
            fill="currentColor"
            stroke="none"
          />
          <path
            className="notify-bell-sparkle notify-bell-step-2"
            d={sparklePath(4.6, 3, 1.4)}
            fill="currentColor"
            stroke="none"
          />
        </g>
      ) : null}
      <g className="notify-bell-body">
        <BellGlyph ringing={ringing} />
      </g>
    </svg>
  );
}
