/** 文字の記号ではなく形で伝える。色が見分けにくい環境でも「使えない」と「注意」を区別できる。 */
export function ProhibitedIcon() {
  return (
    <svg class="up-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M3.7 12.3 12.3 3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}

export function WarningIcon() {
  return (
    <svg class="up-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 2 14.4 13.6H1.6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M8 6v3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="8" cy="11.7" r="0.85" fill="currentColor" />
    </svg>
  );
}
