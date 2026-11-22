import type { ProviderId } from "../api";
import { providerMark } from "../lib/provider-icon";

/** マークだけ。大きさと色は置く場所の CSS で決める。 */
export function ProviderGlyph(props: { provider: ProviderId; class?: string }) {
  const mark = providerMark(props.provider);

  return (
    <svg
      class={props.class}
      viewBox={mark.viewBox}
      fill="currentColor"
      fill-rule={mark.evenodd ? "evenodd" : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {mark.parts.map((part) => (
        <path key={part.d} d={part.d} fill-opacity={part.opacity} />
      ))}
    </svg>
  );
}

/** カード見出しの枠付きのロゴ。名前が同じ行に出るので、読み上げには含めない。 */
export function ProviderIcon(props: { provider: ProviderId }) {
  return (
    <span class="up-provider-icon" aria-hidden="true">
      <ProviderGlyph provider={props.provider} />
    </span>
  );
}
