import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadDefinitions } from "../yaml-loader"

describe("yaml-loader", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  async function setupDirs(
    sites: Record<string, string>,
    scenarios: Record<string, string>,
  ): Promise<{ sitesDir: string; scenariosDir: string }> {
    tmpDir = await mkdtemp(join(tmpdir(), "browser-auto-test-"))
    const sitesDir = join(tmpDir, "sites")
    const scenariosDir = join(tmpDir, "scenarios")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(sitesDir, { recursive: true })
    await mkdir(scenariosDir, { recursive: true })

    for (const [name, content] of Object.entries(sites)) {
      await writeFile(join(sitesDir, `${name}.yaml`), content)
    }
    for (const [name, content] of Object.entries(scenarios)) {
      await writeFile(join(scenariosDir, `${name}.yaml`), content)
    }

    return { sitesDir, scenariosDir }
  }

  test("loads valid definitions", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local: `schemaVersion: 1
id: local
name: Local Test
baseUrl: http://127.0.0.1:3000
`,
      },
      {
        smoke: `schemaVersion: 1
id: smoke
name: Smoke Test
siteId: local
steps:
  - action: goto
    path: /
`,
      },
    )

    const store = await loadDefinitions(sitesDir, scenariosDir)
    expect(store.sites.size).toBe(1)
    expect(store.scenarios.size).toBe(1)
    expect(store.sites.get("local")?.id).toBe("local")
    expect(store.scenarios.get("smoke")?.id).toBe("smoke")
  })

  test("rejects invalid YAML syntax", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local: `schemaVersion: 1
id: local
name: Local
baseUrl: http://127.0.0.1:3000
`,
      },
      {
        broken: `this is: [not valid yaml`,
      },
    )

    await expect(loadDefinitions(sitesDir, scenariosDir)).rejects.toThrow()
  })

  test("rejects duplicate site ids", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local1: `schemaVersion: 1
id: local
name: Site 1
baseUrl: http://127.0.0.1:3000
`,
        local2: `schemaVersion: 1
id: local
name: Site 2
baseUrl: http://127.0.0.1:3001
`,
      },
      {},
    )

    await expect(loadDefinitions(sitesDir, scenariosDir)).rejects.toThrow("Duplicate site id")
  })

  test("rejects duplicate scenario ids", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local: `schemaVersion: 1
id: local
name: Local
baseUrl: http://127.0.0.1:3000
`,
      },
      {
        smoke1: `schemaVersion: 1
id: smoke
name: Smoke 1
siteId: local
steps:
  - action: goto
    path: /
`,
        smoke2: `schemaVersion: 1
id: smoke
name: Smoke 2
siteId: local
steps:
  - action: goto
    path: /
`,
      },
    )

    await expect(loadDefinitions(sitesDir, scenariosDir)).rejects.toThrow("Duplicate scenario id")
  })

  test("rejects unknown siteId in scenario", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local: `schemaVersion: 1
id: local
name: Local
baseUrl: http://127.0.0.1:3000
`,
      },
      {
        smoke: `schemaVersion: 1
id: smoke
name: Smoke
siteId: notfound
steps:
  - action: goto
    path: /
`,
      },
    )

    await expect(loadDefinitions(sitesDir, scenariosDir)).rejects.toThrow("unknown siteId")
  })

  test("rejects schema-invalid YAML", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        bad: `schemaVersion: 2
id: bad
name: Bad
baseUrl: http://127.0.0.1:3000
`,
      },
      {},
    )

    await expect(loadDefinitions(sitesDir, scenariosDir)).rejects.toThrow()
  })

  test("ignores non-yaml files", async () => {
    const { sitesDir, scenariosDir } = await setupDirs(
      {
        local: `schemaVersion: 1
id: local
name: Local
baseUrl: http://127.0.0.1:3000
`,
      },
      {},
    )
    await writeFile(join(sitesDir, "readme.md"), "# Site docs")

    const store = await loadDefinitions(sitesDir, scenariosDir)
    expect(store.sites.size).toBe(1)
  })
})
