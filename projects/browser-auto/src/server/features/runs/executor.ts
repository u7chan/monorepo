import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright"
import type { ScenarioDefinition, Step, SiteDefinition } from "../scenarios/schema"
import { setStepIndex, finishRunSucceeded, finishRunFailed, getCurrentRun } from "./state"
import { logger as defaultLogger } from "../../logger"
import type pino from "pino"

const DEFAULT_STEP_TIMEOUT_MS = 30_000

async function executeGoto(
  page: Page,
  step: Step,
  baseUrl: string,
  stepTimeoutMs: number,
): Promise<void> {
  if (step.action !== "goto") return
  const url = `${baseUrl}${step.path}`
  await page.goto(url, { timeout: stepTimeoutMs, waitUntil: "domcontentloaded" })
}

async function executeAssertVisible(
  page: Page,
  step: Step,
  _baseUrl: string,
  stepTimeoutMs: number,
): Promise<void> {
  if (step.action !== "assertVisible") return
  const locator: Locator = page.getByText(step.locator.text, { exact: true })
  await locator.waitFor({ state: "visible", timeout: stepTimeoutMs })
}

const stepExecutors: Record<
  string,
  (page: Page, step: Step, baseUrl: string, stepTimeoutMs: number) => Promise<void>
> = {
  goto: executeGoto,
  assertVisible: executeAssertVisible,
}

export interface ExecuteOptions {
  stepTimeoutMs?: number
  logger?: pino.Logger
}

export async function executeScenario(
  scenario: ScenarioDefinition,
  site: SiteDefinition,
  options: ExecuteOptions = {},
): Promise<void> {
  const log = options.logger ?? defaultLogger
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  let page: Page | null = null

  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext()
    page = await context.newPage()

    for (let i = 0; i < scenario.steps.length; i++) {
      setStepIndex(i)
      const step = scenario.steps[i]!
      const executor = stepExecutors[step.action]
      if (!executor) {
        throw new Error(`Unknown action: ${step.action}`)
      }
      log.debug({ stepIndex: i, action: step.action, scenarioId: scenario.id }, "Step executing")
      await executor(page, step, site.baseUrl, stepTimeoutMs)
    }

    const run = getCurrentRun()
    log.info({ runId: run?.runId, scenarioId: scenario.id, status: "succeeded" }, "Run succeeded")
    finishRunSucceeded()
  } catch (error) {
    const current = getCurrentRun()
    const stepIndex = current?.stepIndex ?? 0
    const message = error instanceof Error ? error.message : String(error)
    log.error({ stepIndex, scenarioId: scenario.id, err: error }, "Step failed")
    finishRunFailed(stepIndex, message)
  } finally {
    if (page) await page.close().catch((e) => log.warn(e, "Page close failed"))
    if (context) await context.close().catch((e) => log.warn(e, "Context close failed"))
    if (browser) await browser.close().catch((e) => log.warn(e, "Browser close failed"))
  }
}
