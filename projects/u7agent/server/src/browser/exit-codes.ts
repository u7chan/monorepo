/**
 * CLI の終了コード。`check` の「検証は動いたがアプリが失敗した」と「そもそも動かなかった」を
 * 呼び出し元 (bash / エージェント) が区別できるようにする。
 */

/** 正常終了 (check は失敗 0 件、self-test は全 probe 通過) */
export const EXIT_OK = 0;

/** 検証失敗。アプリの応答が失敗の意味だった場合で、CLI 自体は最後まで動いた */
export const EXIT_VALIDATION_FAILED = 1;

/** 起動・入力エラー。引数、外部到達の拒否、ブラウザ起動、期限超過 */
export const EXIT_ERROR = 2;
