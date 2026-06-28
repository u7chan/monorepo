import { z } from "zod/v4"

export const siteDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
})
export type SiteDefinition = z.infer<typeof siteDefinitionSchema>

export const locatorSchema = z.object({
  text: z.string().min(1),
})

export const gotoStepSchema = z.object({
  action: z.literal("goto"),
  path: z.string().startsWith("/"),
})

export const assertVisibleStepSchema = z.object({
  action: z.literal("assertVisible"),
  locator: locatorSchema,
})

export const stepSchema = z.discriminatedUnion("action", [gotoStepSchema, assertVisibleStepSchema])
export type Step = z.infer<typeof stepSchema>

export const scenarioDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  siteId: z.string().min(1),
  steps: z.array(stepSchema).min(1),
})
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>
