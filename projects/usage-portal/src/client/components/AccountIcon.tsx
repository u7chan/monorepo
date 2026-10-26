import { accountIconColor } from "../lib/account-color";

/** アイコンは装飾。名前が同じ行に出るので、読み上げには含めない。 */
export function AccountIcon(props: { id: string; icon: string }) {
  return (
    <span class="up-account-icon" aria-hidden="true" style={{ backgroundColor: accountIconColor(props.id) }}>
      {props.icon}
    </span>
  );
}
