import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright'
import { BASE_URL, setupE2E, teardownE2E, TEST_PROJECT_ID } from './setup'

let page: Page

beforeAll(async () => {
  ;({ page } = await setupE2E())
}, 15000)

afterAll(async () => {
  await teardownE2E(page)
}, 10000)

describe('Smoke tests', () => {
  test('projects page loads', async () => {
    await page.goto(`${BASE_URL}/projects`)
    await page.getByTestId('projects-title').waitFor({ state: 'visible', timeout: 10000 })
    const title = await page.getByTestId('projects-title').textContent()
    expect(title).toBe('プロジェクト')
  })

  test('navigates to editor page', async () => {
    await page.goto(`${BASE_URL}/projects/${TEST_PROJECT_ID}`)
    await page.waitForSelector('video', { timeout: 10000 })
    const videoCount = await page.locator('video').count()
    expect(videoCount).toBeGreaterThan(0)
  })

  test('editor page shows project name', async () => {
    await page.goto(`${BASE_URL}/projects/${TEST_PROJECT_ID}`)
    await page.waitForSelector('video', { timeout: 10000 })
    const heading = await page.getByTestId('editor-title').textContent()
    expect(heading).toBe('E2E Test Project')
  })
})
