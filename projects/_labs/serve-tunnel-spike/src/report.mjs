import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mask } from "./tunnel.mjs";

export function sanitize(value) {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function renderFacts(facts) {
  return JSON.stringify(sanitize(facts), null, 2);
}

export function renderMarkdown(report) {
  const lines = [
    "# Quick Tunnel spike report",
    "",
    `- 実行: ${report.environment.startedAt}`,
    `- 環境: ${report.environment.platform} / ${report.environment.arch} / Node ${report.environment.node}`,
    `- cloudflared: ${report.environment.cloudflared}`,
    `- sha256: \`${report.environment.sha256}\``,
    "",
    "## 結果",
    "",
    "| 項目 | 判定 | 要点 |",
    "| --- | --- | --- |",
  ];
  for (const check of report.checks) {
    const summary = mask(check.summary ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${check.id} | ${check.verdict} | ${summary} |`);
  }
  lines.push("");
  for (const check of report.checks) {
    lines.push(`## ${check.id}: ${check.title}`, "", `**${check.verdict}**`, "");
    if (check.note) lines.push(mask(check.note), "");
    lines.push("```json", renderFacts(check.facts), "```", "");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeReport(outDir, report) {
  await mkdir(outDir, { recursive: true });
  const safe = sanitize(report);
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(safe, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  await writeFile(join(outDir, "report.md"), markdown);
  return markdown;
}
