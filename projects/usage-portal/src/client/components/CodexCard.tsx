import { useState } from "preact/hooks";
import type { CodexAuthState, UsageSource } from "../api";
import { showsSignOutButton } from "../lib/codex-signin";
import { CodexAuthPanel, type CodexActions } from "./CodexAuthPanel";
import { OverflowMenu, type MenuItem } from "./OverflowMenu";
import { ProviderCard } from "./ProviderCard";

/** Codex カード 1 枚ぶん。サインアウトは見出しのメニュー、サインインの進行はカードの中に出す。 */
export function CodexCard(props: {
  source: UsageSource;
  now: number;
  generatedAt: number | null;
  compact?: boolean;
  auth: CodexAuthState | null;
  actions: CodexActions;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const needsSignIn = props.source.error?.code === "not_connected" || props.source.error?.code === "reauth_required";
  const showSignOut = showsSignOutButton({
    known: props.auth !== null,
    needsSignIn,
    signedIn: props.auth?.signedIn ?? false,
    loginStatus: props.auth?.login?.status ?? null,
  });

  const signOut = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const ok = await props.actions.onLogout();

      if (!ok) {
        setMessage("サインアウトできませんでした。もう一度試してください。");
      }
    } catch {
      setMessage("通信に失敗しました。もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = showSignOut
    ? [{ label: "サインアウト", onSelect: () => void signOut(), disabled: busy, danger: true }]
    : [];

  return (
    <ProviderCard
      source={props.source}
      now={props.now}
      generatedAt={props.generatedAt}
      compact={props.compact}
      headerMenu={items.length > 0 ? <OverflowMenu label="Codex の操作" items={items} /> : undefined}
    >
      <CodexAuthPanel auth={props.auth} actions={props.actions} needsSignIn={needsSignIn} message={message} />
    </ProviderCard>
  );
}
