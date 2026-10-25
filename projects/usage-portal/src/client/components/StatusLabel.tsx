import type { ProviderStatus } from "../lib/status";

export function StatusLabel(props: { status: ProviderStatus }) {
  return (
    <span class={`up-status up-status-${props.status.tone}`}>
      <span class="up-status-symbol" aria-hidden="true">
        {props.status.symbol}
      </span>
      {props.status.label}
    </span>
  );
}
