// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SvgIcon } from '#/client/shared/icons/icon-base'

describe('SvgIcon', () => {
  it('label 未指定時は aria-hidden 付きの装飾SVGとして扱われる', () => {
    const { container } = render(
      <SvgIcon>
        <path />
      </SvgIcon>
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.hasAttribute('role')).toBe(false)
    expect(svg?.hasAttribute('aria-label')).toBe(false)
  })

  it('label 指定時は role=img の画像として読み上げられる', () => {
    render(
      <SvgIcon label='内容をコピー'>
        <path />
      </SvgIcon>
    )
    expect(screen.getByRole('img', { name: '内容をコピー' })).toBeTruthy()
  })

  it('className とSVG標準propsをルート要素へ forward する', () => {
    const { container } = render(
      <SvgIcon className='size-5 text-gray-500' data-testid='icon' aria-describedby='desc'>
        <path />
      </SvgIcon>
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('class')).toContain('size-5')
    expect(svg?.getAttribute('class')).toContain('text-gray-500')
    expect(svg?.getAttribute('data-testid')).toBe('icon')
    expect(svg?.getAttribute('aria-describedby')).toBe('desc')
  })
})
