import type { ProviderId } from "../api";
import { providerIconPaths } from "../lib/provider-icon";

/** provider のロゴ。名前が同じ行に出るので、読み上げには含めない。 */
export function ProviderIcon(props: { provider: ProviderId }) {
  return (
    <span class="up-provider-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" focusable="false">
        {providerIconPaths(props.provider).map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    </span>
  );
}
