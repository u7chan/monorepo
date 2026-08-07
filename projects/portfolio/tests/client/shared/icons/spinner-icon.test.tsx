// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SpinnerIcon } from '#/client/shared/icons/spinner-icon'

describe('SpinnerIcon', () => {
  it('複数同時表示でもグラデーションIDが重複しない', () => {
    const { container } = render(
      <>
        <SpinnerIcon />
        <SpinnerIcon />
      </>
    )
    const defs = container.querySelectorAll('defs linearGradient')
    expect(defs.length).toBe(2)
    const firstId = defs[0]?.getAttribute('id')
    const secondId = defs[1]?.getAttribute('id')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
  })

  it('size 指定が width/height に反映される', () => {
    const { container } = render(<SpinnerIcon size={16} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('height')).toBe('16')
  })

  it('label 指定時は role=img の画像として読み上げられる', () => {
    const { container } = render(<SpinnerIcon label='Loading' />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('Loading')
  })
})
