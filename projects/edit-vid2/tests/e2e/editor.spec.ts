import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
  await page.getByRole('button', { name: /字幕追加/ }).click()
  const input = page.getByPlaceholder('字幕テキスト')
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('input[placeholder="字幕テキスト"]') as HTMLInputElement | null
      return el && el.value === ''
    },
    { timeout: 5000 }
  )
  return input
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

async function waitForProjectPatchResponse(): Promise<void> {
  const response = await page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && res.url().includes(`/api/projects/${TEST_PROJECT_ID}`)
  )
  expect(response.ok()).toBe(true)
}

async function expectProjectSubtitleText(text: string): Promise<void> {
  const response = await page.request.get(`${BASE_URL}/api/projects/${TEST_PROJECT_ID}`)
  expect(response.ok()).toBe(true)
  const project = await response.json()
  const subtitles = project.timelineState?.tracks?.find((track: { type: string }) => track.type === 'subtitle')?.items
  expect(subtitles?.some((item: { text: string }) => item.text === text)).toBe(true)
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

  test('timeline interaction pauses playback', async () => {
    await resetVideo()

    await page.getByTestId('editor-root').focus()
    await page.keyboard.press('Space')
    await waitForPlaybackState(false)

    const bar = seekBar()
    const box = await bar.boundingBox()
    if (!box) throw new Error('Seek bar not found')

    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
    await waitForPlaybackState(true)
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

      expect(tracker.count).toBe(0)

      const patchResponse = waitForProjectPatchResponse()
      await endComposition(input, 'こんにちは')
      await patchResponse

      expect(tracker.count).toBe(1)
      expect(await input.inputValue()).toBe('こんにちは')
      await expectProjectSubtitleText('こんにちは')
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

      expect(tracker.count).toBe(0)

      await inputComposingText(input, '未確定')
      const patchResponse = waitForProjectPatchResponse()
      await input.evaluate((node) => {
        ;(node as HTMLInputElement).blur()
      })
      await patchResponse

      expect(tracker.count).toBe(1)
      expect(await input.inputValue()).toBe('未確定')
      await expectProjectSubtitleText('未確定')
    } finally {
      tracker.dispose()
    }
  })

  test('saves normal text input without composition', async () => {
    const input = await addSubtitle()
    const patchResponse = waitForProjectPatchResponse()

    await input.fill('plain subtitle')
    await patchResponse

    expect(await input.inputValue()).toBe('plain subtitle')
    await expectProjectSubtitleText('plain subtitle')
  })
})

async function expectProjectTrimStart(value: number): Promise<void> {
  const response = await page.request.get(`${BASE_URL}/api/projects/${TEST_PROJECT_ID}`)
  expect(response.ok()).toBe(true)
  const project = await response.json()
  expect(project.timelineState?.keepSegments?.[0]?.sourceStart).toBe(value)
}

async function getSubtitleClipById(id: string): Promise<Locator> {
  return page.locator(`[data-testid="timeline-subtitle-item"][data-subtitle-id="${id}"]`)
}

async function addSubtitleWithText(
  text: string
): Promise<{ input: Locator; item: NonNullable<Awaited<ReturnType<typeof getLatestSubtitleItem>>> }> {
  const input = await addSubtitle()
  const patchResponse = waitForProjectPatchResponse()
  await input.fill(text)
  await patchResponse
  const item = await getLatestSubtitleItem()
  expect(item).not.toBeNull()
  return { input, item: item! }
}

async function clearSubtitles(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/projects/${TEST_PROJECT_ID}`)
  expect(response.ok).toBe(true)
  const project = await response.json()
  const tracks = project.timelineState?.tracks ?? []
  const newTracks = tracks.map((track: { type: string; id: string; items: unknown[] }) =>
    track.type === 'subtitle' ? { ...track, items: [] } : track
  )
  const patch = await fetch(`${BASE_URL}/api/projects/${TEST_PROJECT_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timelineState: { ...project.timelineState, tracks: newTracks } }),
  })
  expect(patch.ok).toBe(true)
  await page.reload()
  await page.waitForSelector('video', { timeout: 10000 })
}

async function getLatestSubtitleItem(): Promise<{
  id: string
  sourceStart: number
  sourceEnd: number
  text: string
} | null> {
  const response = await page.request.get(`${BASE_URL}/api/projects/${TEST_PROJECT_ID}`)
  expect(response.ok()).toBe(true)
  const project = await response.json()
  const items: Array<{ id: string; sourceStart: number; sourceEnd: number; text: string }> =
    project.timelineState?.tracks?.find((track: { type: string }) => track.type === 'subtitle')?.items ?? []
  if (items.length === 0) return null
  return items.sort((a, b) => a.sourceStart - b.sourceStart)[items.length - 1]
}

describe('Trim time input', () => {
  test('commits start time on blur, not while typing', async () => {
    await resetVideo()

    const input = page.getByTestId('trim-start-input')
    expect(await input.inputValue()).toBe('0.0')

    const tracker = trackProjectPatchRequests()
    try {
      await input.focus()
      await input.fill('1.5')
      expect(tracker.count).toBe(0)

      const patchResponse = waitForProjectPatchResponse()
      await input.evaluate((node) => {
        ;(node as HTMLInputElement).blur()
      })
      await patchResponse

      expect(tracker.count).toBe(1)
      expect(await input.inputValue()).toBe('1.5')
      await expectProjectTrimStart(1.5)
    } finally {
      tracker.dispose()
    }
  })

  test('reverts invalid input on blur', async () => {
    const input = page.getByTestId('trim-start-input')

    // Prepare a known committed value so this test does not depend on the previous one.
    await input.fill('2.0')
    const patchResponse = waitForProjectPatchResponse()
    await input.evaluate((node) => {
      ;(node as HTMLInputElement).blur()
    })
    await patchResponse
    expect(await input.inputValue()).toBe('2.0')

    // Non-numeric input should revert to the last committed value.
    await input.fill('abc')
    await input.evaluate((node) => {
      ;(node as HTMLInputElement).blur()
    })
    expect(await input.inputValue()).toBe('2.0')

    // Partial-numeric input (parseFloat would accept the leading digits) should also revert.
    await input.fill('1abc')
    await input.evaluate((node) => {
      ;(node as HTMLInputElement).blur()
    })
    expect(await input.inputValue()).toBe('2.0')
  })
})

describe('Timeline subtitle clip interaction', () => {
  beforeEach(async () => {
    await clearSubtitles()
    await resetVideo()
  })

  test('clicking a clip selects it and shows the detail form', async () => {
    const { item } = await addSubtitleWithText('select me')

    const detailForm = page.getByTestId('subtitle-detail-form')
    await detailForm.waitFor({ state: 'visible', timeout: 5000 })

    // Deselect first by clicking the timeline seek bar empty area.
    const bar = seekBar()
    const barBox = await bar.boundingBox()
    if (!barBox) throw new Error('Seek bar not found')
    await page.mouse.click(barBox.x + 1, barBox.y + barBox.height / 2)

    const clip = await getSubtitleClipById(item.id)
    await clip.click()

    const selectedInput = page.getByPlaceholder('字幕テキスト')
    expect(await selectedInput.inputValue()).toBe('select me')
  })

  test('dragging a clip body shifts sourceStart and sourceEnd', async () => {
    const { item } = await addSubtitleWithText('drag me')

    const clip = await getSubtitleClipById(item.id)
    const box = await clip.boundingBox()
    if (!box) throw new Error('Subtitle clip not found')

    const startX = box.x + box.width / 2
    const endX = startX + 40
    const y = box.y + box.height / 2

    const patchResponse = waitForProjectPatchResponse()
    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(endX, y, { steps: 10 })
    await page.mouse.up()
    await patchResponse

    const after = await getLatestSubtitleItem()
    expect(after).not.toBeNull()
    expect(after!.sourceStart).toBeGreaterThan(item.sourceStart)
    expect(after!.sourceEnd - after!.sourceStart).toBeCloseTo(item.sourceEnd - item.sourceStart, 1)
  })

  test('dragging the right edge resizes sourceEnd', async () => {
    const { item } = await addSubtitleWithText('resize me')

    const clip = await getSubtitleClipById(item.id)
    const box = await clip.boundingBox()
    if (!box) throw new Error('Subtitle clip not found')

    const handle = clip.locator('[data-testid="timeline-subtitle-resize-end"]')
    const handleBox = await handle.boundingBox()
    if (!handleBox) throw new Error('Resize handle not found')

    const startX = handleBox.x + handleBox.width / 2
    const endX = startX + 30
    const y = handleBox.y + handleBox.height / 2

    const patchResponse = waitForProjectPatchResponse()
    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(endX, y, { steps: 10 })
    await page.mouse.up()
    await patchResponse

    const after = await getLatestSubtitleItem()
    expect(after).not.toBeNull()
    expect(after!.sourceEnd).toBeGreaterThan(item.sourceEnd)
    expect(after!.sourceStart).toBeCloseTo(item.sourceStart, 1)
  })
})
