import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Locator, Page, Request } from 'playwright'
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
}, 15000)

afterAll(async () => {
  await teardownE2E(page)
}, 10000)

async function getTimeDisplay(): Promise<string> {
  return (await page.getByTestId('timeline-current-time').textContent()) ?? ''
}

async function resetVideo() {
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement
    v?.pause()
  })
  const bar = seekBar()
  const box = await bar.boundingBox()
  if (!box) throw new Error('Seek bar not found')
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await waitForTimeDisplay('0:00')
}

function seekBar() {
  return page.getByTestId('timeline-seek-bar')
}

async function waitForTimeDisplay(expected: string): Promise<void> {
  await page.waitForFunction(
    ({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.textContent === value,
    { testId: 'timeline-current-time', value: expected }
  )
}

async function waitForTimeDisplayToChange(previous: string): Promise<void> {
  await page.waitForFunction(
    ({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.textContent !== value,
    { testId: 'timeline-current-time', value: previous }
  )
}

async function waitForPlaybackState(paused: boolean): Promise<void> {
  await page.waitForFunction(
    (expectedPaused) => {
      const video = document.querySelector('video') as HTMLVideoElement | null
      return video?.paused === expectedPaused
    },
    paused,
    { timeout: 5000 }
  )
}

async function addSubtitle(): Promise<Locator> {
  const inputs = page.getByPlaceholder('字幕テキスト')
  const before = await inputs.count()
  await page.getByRole('button', { name: /字幕追加/ }).click()
  await page.waitForFunction(
    ({ placeholder, count }) => document.querySelectorAll(`input[placeholder="${placeholder}"]`).length > count,
    { placeholder: '字幕テキスト', count: before }
  )
  return inputs.last()
}

function trackProjectPatchRequests() {
  let count = 0
  const handler = (request: Request) => {
    if (request.method() === 'PATCH' && request.url().includes(`/api/projects/${TEST_PROJECT_ID}`)) {
      count++
    }
  }
  page.on('request', handler)

  return {
    get count() {
      return count
    },
    dispose() {
      page.off('request', handler)
    },
  }
}

async function inputComposingText(input: Locator, text: string): Promise<void> {
  await input.evaluate((node, value) => {
    const element = node as HTMLInputElement
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.value = value
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertCompositionText',
        isComposing: true,
      })
    )
  }, text)
}

async function endComposition(input: Locator, text: string): Promise<void> {
  await input.evaluate((node, value) => {
    const element = node as HTMLInputElement
    element.value = value
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }))
  }, text)
}

async function pressComposingEnter(input: Locator): Promise<void> {
  await input.evaluate((node) => {
    const element = node as HTMLInputElement
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }))
  })
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
    await waitForTimeDisplayToChange(timeBefore)

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
    await waitForTimeDisplayToChange('0:00')

    const timeAfter = await getTimeDisplay()
    expect(timeAfter).not.toBe('0:00')
  })

  test('space key toggles play/pause', async () => {
    await resetVideo()

    await page.getByTestId('editor-root').focus()

    const wasPaused = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? v.paused : true
    })
    expect(wasPaused).toBe(true)

    await page.keyboard.press('Space')
    await waitForPlaybackState(false)

    const isPlaying = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? !v.paused : false
    })
    expect(isPlaying).toBe(true)

    await page.getByTestId('editor-root').focus()
    await page.keyboard.press('Space')
    await waitForPlaybackState(true)

    const isPaused = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement
      return v ? v.paused : true
    })
    expect(isPaused).toBe(true)
  })
})

describe('Subtitle text input IME handling', () => {
  test('defers saving during composition and saves once on compositionend', async () => {
    const input = await addSubtitle()
    const tracker = trackProjectPatchRequests()

    try {
      await input.focus()
      await inputComposingText(input, 'こんに')
      await pressComposingEnter(input)
      await page.waitForTimeout(100)

      expect(tracker.count).toBe(0)

      await endComposition(input, 'こんにちは')
      await page.waitForTimeout(100)

      expect(tracker.count).toBe(1)
      expect(await input.inputValue()).toBe('こんにちは')
    } finally {
      tracker.dispose()
    }
  })

  test('saves composing draft on blur', async () => {
    const input = await addSubtitle()
    const tracker = trackProjectPatchRequests()

    try {
      await input.focus()
      await inputComposingText(input, '未確定')
      await page.waitForTimeout(100)

      expect(tracker.count).toBe(0)

      await inputComposingText(input, '未確定')
      await input.evaluate((node) => {
        ;(node as HTMLInputElement).blur()
      })
      await page.waitForTimeout(100)

      expect(tracker.count).toBe(1)
      expect(await input.inputValue()).toBe('未確定')
    } finally {
      tracker.dispose()
    }
  })
})
