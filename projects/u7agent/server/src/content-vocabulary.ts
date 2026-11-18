/**
 * コンテンツ生成の語彙 (zod の enum を作るための値)。schema モジュールはここから読む。
 * ここへ値を集めているのは、schema が content-cost / content-trial-artifacts / content-trials を
 * (型だけでなく値として) 参照すると、モジュール初期化の時点で循環の相手を読むことになるため。
 */

/** 上流の `unit` 語彙。これ以外の行は捨て、`0` へ丸めない */
export const COST_UNITS = ["image", "megapixel", "token", "character", "byte", "minute", "request"] as const;

/** 入力 / 出力の区別。マスタの `billable` はここへ正規化してから DTO に載せる */
export const COST_SIDES = ["input", "output"] as const;
