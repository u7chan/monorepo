// session.ts を import しただけの時点で有効な PLAYWRIGHT_BROWSERS_PATH を出す (import 順序の検査用)。
// この import が ./environment より先に playwright-core を読み込むと、既定が registry へ届かない。
import "../src/browser/session";

process.stdout.write(`${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "unset"}\n`);
