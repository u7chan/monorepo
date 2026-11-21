// AppHeader - 上端に固定するナビバー。大きいタイトルが画面外へ出ると、バーの中央にタイトルが現れる

import portalLogo from "../logo.svg";
import { GLASS } from "./glass";
import { SlidersIcon } from "./icons";

interface AppHeaderProps {
  /** 大きいタイトルがバーの下に隠れたか */
  compact: boolean;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}

export function AppHeader({ compact, settingsOpen, onOpenSettings }: AppHeaderProps) {
  return (
    <header
      className={[
        "sticky top-0 z-40 border-b pt-[env(safe-area-inset-top)] transition-colors duration-200",
        // スクロール前は背景なし。内容が下に潜り込んだときだけ、ガラスと境界線が現れる
        compact ? `${GLASS} border-separator` : "border-transparent bg-transparent",
      ].join(" ")}
    >
      <div className="page-gutter relative mx-auto flex h-11 max-w-6xl items-center justify-between">
        <img src={portalLogo} alt="" className="size-7 shrink-0" />

        <p
          aria-hidden="true"
          className={[
            "pointer-events-none absolute inset-x-0 text-center text-headline font-semibold",
            "transition-[opacity,translate] duration-200 ease-ios",
            compact ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
          ].join(" ")}
        >
          Containers
        </p>

        <button
          type="button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
          className="hit-area -mr-2 grid size-10 place-items-center rounded-full text-accent transition-colors duration-150 can-hover:hover:bg-fill active:bg-fill"
        >
          <SlidersIcon className="size-6" />
        </button>
      </div>
    </header>
  );
}

export default AppHeader;
