// scripts/lan-access.sh と scripts/pair.sh が、Windows 側の処理を共通ヘルパー（windows-lan.sh）でだけ
// 持つことを固定する。ローカルで再定義すると、共通ヘルパーの修正が片方に反映されない。
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const SCRIPTS = ["lan-access.sh", "pair.sh"] as const
const SHARED_HELPERS = ["die", "substitute", "run_powershell", "detect_windows_lan"] as const

function readScript(name: string): string {
  return readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8")
}

test("Windows 側の処理は windows-lan.sh を source してのみ持つ", () => {
  for (const name of SCRIPTS) {
    const script = readScript(name)

    assert.match(script, /^source "\$SCRIPT_DIR\/windows-lan\.sh"$/m, `${name} が windows-lan.sh を source していない`)

    for (const helper of SHARED_HELPERS) {
      assert.equal(
        new RegExp(`^${helper}\\(\\) \\{`, "m").test(script),
        false,
        `${name} が ${helper} を再定義している`,
      )
    }
  }
})

test("windows-lan.sh は共有する関数をすべて定義する", () => {
  const script = readScript("windows-lan.sh")

  for (const helper of SHARED_HELPERS) {
    assert.equal(new RegExp(`^${helper}\\(\\) \\{`, "m").test(script), true, `windows-lan.sh に ${helper} がない`)
  }
})
