import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrices, type GenerateSummary } from "../src/server/generate";
import { parsePriceFile, type PriceMasterFile, type PriceRow } from "../src/server/master";
import { formatCost } from "../src/shared/format";

const dryRun = process.argv.includes("--dry-run");
const root = resolve(import.meta.dir, "..");
const target = resolve(root, "src/server/data/prices.json");
const previous = readPrevious(target);
const result = await generatePrices({ fetchImpl: fetch, previous, now: Date.now });

if (!result.ok) {
  console.error(`価格を取り込めませんでした: ${result.reason}（prices.json は変更していません）`);
  process.exit(1);
}

printSummary(result.summary, previous, result.file);
printDiff(result.summary.diff);

if (dryRun) {
  console.log("--dry-run のため書き込みません");
  process.exit(0);
}

writeFileSync(target, `${JSON.stringify(result.file, null, 2)}\n`);
console.log(`書き込みました: ${target}`);
process.exit(0);

function readPrevious(path: string): PriceMasterFile | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const parsed = parsePriceFile(value);

  return parsed.ok ? { version: parsed.version, fetchedAt: parsed.fetchedAt, models: parsed.rows } : null;
}

function printSummary(summary: GenerateSummary, before: PriceMasterFile | null, after: PriceMasterFile): void {
  const failed = summary.failed.length === 0 ? "0" : `${summary.failed.length}（${summary.failed.join(", ")}）`;

  console.log(
    [
      `モデル ${summary.models} 件`,
      `価格あり ${summary.priced} 件`,
      `価格なし ${summary.noPrice} 件`,
      `取得失敗 ${failed}`,
      `音声 ${summary.speech.models} 件（価格あり ${summary.speech.priced} / 価格なし ${summary.speech.unpriced.length} / 失敗 ${summary.speech.failed.length}）`,
      `行 ${before?.models.length ?? 0} → ${summary.rows}`,
      summary.changed ? `version ${before?.version ?? 0} → ${after.version}` : `version ${after.version}（変更なし）`,
    ].join(" / "),
  );
}

function printDiff(diff: GenerateSummary["diff"]): void {
  for (const row of diff.added) {
    console.log(`+ ${describe(row)}`);
  }

  for (const row of diff.removed) {
    console.log(`- ${describe(row)}`);
  }

  for (const { before, after } of diff.changed) {
    console.log(
      `~ ${describe(after)} (${formatCost(before.costUsd, before.unit)} → ${formatCost(after.costUsd, after.unit)})`,
    );
  }

  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    console.log("価格の差分はありません");
  }
}

function describe(row: PriceRow): string {
  const variant = row.variant === "" ? "-" : row.variant;

  return `${row.modelId} ${row.billable} ${row.unit} ${variant} ${formatCost(row.costUsd, row.unit)}`;
}
