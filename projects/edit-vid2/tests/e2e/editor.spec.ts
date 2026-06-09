import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Page } from 'playwright'
import { BASE_URL, setupE2E, teardownE2E, TEST_PROJECT_ID } from './setup'

let page: Page

beforeAll(async () => {
  ;({ page } = await setupE2E())
  await page.goto(`${BASE_URL}/projects/${TEST_PROJECT_ID}`)
  await page.waitForSelector('video', { timeout: 10000 })
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video')
      return v && v.readyState >= 2
    },
    { timeout: 10000 }
  )
})

afterAll(async () => {
  await teardownE2E(page)
})

async function getTimeDisplay(): Promise<string> {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('[class*="h-20"] span')
    return spans[0]?.textContent ?? ''
  })
}

async function resetVideo() {
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement
    if (v) {
      v.pause()
      v.currentTime = 0
    }
  })
  await page.waitForTimeout(200)
}

function seekBar() {
  return page.locator('.h-20 .h-10.cursor-pointer')
}

describe('Editor seek bar', () => {
  test('seek bar click updates time display', async () => {
    await resetVideo()

    const bar = seekBar()
    await bar.waitFor({ state: 'visible', timeout: 5000 })

    const timeBefore = await getTimeDisplay()
    expect(timeBefore).toBe('0:00')

    const box = await bar.boundingBox()
    if (!box) throw new Error('Seek bar not found')

    const clickX = box.x + box.width * 0.7
    const clickY = box.y + box.height / 2
    await page.mouse.click(clickX, clickY)
    await page.waitForTimeout(500)

    const timeAfter = await getTimeDisplay()
    expect(timeAfter).not.toBe('0:00')
  })

  test('seek bar drag updates time display', async () => {
    await resetVideo()

    const bar = seekBar()
    const box = await bar.boundingBox()
    if (!box) throw new Error('Seek bar not found')

    const startX = box.x + box.width * 0.2
    const endX = box.x + box.width * 0.8
    const y = box.y + box.height / 2

    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(endX, y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const timeAfter = await getTimeDisplay()
    expect(timeAfter).not.toBe('0:00')
  })

  test('space key toggles play/pause', async () => {
    await resetVideo()

    await page.locator('.outline-none').focus()

    const wasPaused = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? v.paused : true
    })
    expect(wasPaused).toBe(true)

    await page.keyboard.press('Space')
    await page.waitForTimeout(800)

    const isPlaying = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? !v.paused : false
    })
    expect(isPlaying).toBe(true)

    await page.locator('.outline-none').focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(500)

    const isPaused = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? v.paused : true
    })
    expect(isPaused).toBe(true)
  })
})
