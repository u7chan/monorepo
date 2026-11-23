import type { ProviderId } from "../api";
import { providerMark } from "../lib/provider-icon";
import type { ProviderMarkColor } from "../lib/status";

/** マークだけ。大きさと色は置く場所の CSS で決める。 */
export function ProviderGlyph(props: { provider: ProviderId; class?: string }) {
  const mark = providerMark(props.provider);

  return (
    <svg
      class={props.class}
      data-provider={props.provider}
      viewBox={mark.viewBox}
      fill="currentColor"
      fill-rule={mark.evenodd ? "evenodd" : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {mark.parts.map((part) => (
        <path key={part.d} d={part.d} class={part.shade ? "up-provider-mark-shade" : undefined} />
      ))}
    </svg>
  );
}

/** カード見出しの枠付きのロゴ。名前が同じ行に出るので、読み上げには含めない。 */
export function ProviderIcon(props: { provider: ProviderId; mark: ProviderMarkColor }) {
  return (
    <span class="up-provider-icon" data-provider={props.provider} data-mark={props.mark} aria-hidden="true">
      <ProviderGlyph provider={props.provider} />
    </span>
  );
}
