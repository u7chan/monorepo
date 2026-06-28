import { readdir, readFile } from "node:fs/promises"
import { join, extname } from "node:path"
import { parse as parseYaml } from "yaml"
import {
  siteDefinitionSchema,
  type SiteDefinition,
  scenarioDefinitionSchema,
  type ScenarioDefinition,
} from "./yaml-schemas"

export interface DefinitionStore {
  sites: Map<string, SiteDefinition>
  scenarios: Map<string, ScenarioDefinition>
}

async function loadFiles<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  const files: T[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (ext !== ".yaml" && ext !== ".yml") continue
    const content = await readFile(join(dir, entry.name), "utf-8")
    const parsed = parseYaml(content)
    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new Error(`Invalid YAML file ${join(dir, entry.name)}: ${result.error.message}`)
    }
    files.push(result.data)
  }
  return files
}

function checkDuplicateIds<T extends { id: string }>(items: T[], label: string): void {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`Duplicate ${label} id: ${item.id}`)
    }
    ids.add(item.id)
  }
}

export async function loadDefinitions(
  sitesDir: string,
  scenariosDir: string,
): Promise<DefinitionStore> {
  const sites = await loadFiles(sitesDir, siteDefinitionSchema)
  checkDuplicateIds(sites, "site")

  const scenarios = await loadFiles(scenariosDir, scenarioDefinitionSchema)
  checkDuplicateIds(scenarios, "scenario")

  const siteIds = new Set(sites.map((s) => s.id))
  for (const scenario of scenarios) {
    if (!siteIds.has(scenario.siteId)) {
      throw new Error(`Scenario "${scenario.id}" references unknown siteId: ${scenario.siteId}`)
    }
  }

  return {
    sites: new Map(sites.map((s) => [s.id, s])),
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
  }
}

import type { z } from "zod/v4"
