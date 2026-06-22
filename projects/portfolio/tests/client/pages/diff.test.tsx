// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const saveDiffStateMock = vi.fn()

vi.mock('@monaco-editor/react', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('react-diff-viewer', () => ({
  default: ({ newValue, oldValue }: { newValue: string; oldValue: string }) => (
    <div>
      <span>{oldValue}</span>
      <span>{newValue}</span>
    </div>
  ),
}))

vi.mock('#/client/shared/hooks/use-dark-mode', () => ({
  useDarkMode: () => false,
}))

vi.mock('#/client/shared/hooks/use-mobile-layout', () => ({
  useMobileLayout: () => false,
}))

vi.mock('#/client/shared/storage/diff-state', () => ({
  saveDiffState: (...args: unknown[]) => saveDiffStateMock(...args),
}))

import { Diff } from '#/client/features/diff/page'

const initialState = {
  beforeCode: 'saved before',
  afterCode: 'saved after',
}

describe('Diff page', () => {
  it('保存済みコードを初期表示する', () => {
    render(<Diff initialState={initialState} />)

    expect(screen.getByText('saved before')).toBeTruthy()
    expect(screen.getByText('saved after')).toBeTruthy()
  })

  it('編集時に最新のBeforeとAfterを保存する', () => {
    saveDiffStateMock.mockResolvedValue(undefined)
    const { container } = render(<Diff initialState={initialState} />)

    fireEvent.click(container.querySelector('button')!)
    const editors = screen.getAllByRole('textbox')

    fireEvent.change(editors[0], { target: { value: 'updated before' } })
    fireEvent.change(editors[1], { target: { value: 'updated after' } })

    expect(saveDiffStateMock).toHaveBeenNthCalledWith(1, {
      beforeCode: 'updated before',
      afterCode: 'saved after',
    })
    expect(saveDiffStateMock).toHaveBeenNthCalledWith(2, {
      beforeCode: 'updated before',
      afterCode: 'updated after',
    })
  })
})
