// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChevronRightIcon } from '#/client/shared/icons/chevron-right-icon'

describe('ChevronRightIcon', () => {
  it('パスが viewBox の中心に対して左右対称に配置される', () => {
    const { container } = render(<ChevronRightIcon />)
    const d = container.querySelector('path')?.getAttribute('d')
    const coordinates = d?.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    const xs = coordinates.filter((_, i) => i % 2 === 0)
    const ys = coordinates.filter((_, i) => i % 2 === 1)
    // viewBox 0 0 8 8 の中心 (4, 4) に対してグリフが対称になること
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBe(4)
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBe(4)
  })

  it('strokeWidth 未指定時は既定値 1.25 が設定される', () => {
    const { container } = render(<ChevronRightIcon />)
    const path = container.querySelector('path')
    expect(path?.getAttribute('stroke-width')).toBe('1.25')
  })

  it('strokeWidth を指定するとパスに反映される', () => {
    const { container } = render(<ChevronRightIcon strokeWidth={0.75} />)
    const path = container.querySelector('path')
    expect(path?.getAttribute('stroke-width')).toBe('0.75')
  })
})
