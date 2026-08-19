// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChevronRightIcon } from '#/client/shared/icons/chevron-right-icon'

describe('ChevronRightIcon', () => {
  it('パスが viewBox の中心に対して左右対称に配置される', () => {
    const { container } = render(<ChevronRightIcon />)
    const path = container.querySelector('path')
    expect(path?.getAttribute('d')).toBe('M2.5 1.5L5.5 4L2.5 6.5')
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
