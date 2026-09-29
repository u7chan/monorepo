/**
 * user バブルの長文折りたたみ。
 * 実際に切り取る高さは CSS (.user-message-clamp の `max-block-size: 15rem` = 既定フォントで 240px) が持ち、
 * この値は仮想スクロールの見積り (lib/chatItems.ts) にだけ使う。
 */
export const USER_MESSAGE_CLAMP_PX = 240;
