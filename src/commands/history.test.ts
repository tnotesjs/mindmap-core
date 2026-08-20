import { describe, expect, it } from 'vitest'
import { History } from './history'

describe('History', () => {
  it('undo 返回上一份快照，redo 返回被撤销的快照', () => {
    const h = new History()
    h.record('v1')
    h.record('v2')
    expect(h.canUndo).toBe(true)

    expect(h.undo('v3')).toBe('v2')
    expect(h.undo('v2')).toBe('v1')
    expect(h.undo('v1')).toBeNull()

    expect(h.canRedo).toBe(true)
    expect(h.redo('v1')).toBe('v2')
    expect(h.redo('v2')).toBe('v3')
    expect(h.redo('v3')).toBeNull()
  })

  it('新变更清空 redo 栈', () => {
    const h = new History()
    h.record('v1') // v1 → v2
    expect(h.undo('v2')).toBe('v1') // 回到 v1
    h.record('v1') // 从 v1 做新变更 → v3（record 的是变更前的 v1）
    expect(h.canRedo).toBe(false)
    expect(h.undo('v3')).toBe('v1')
    expect(h.undo('v1')).toBeNull()
  })

  it('超出容量丢弃最早快照', () => {
    const h = new History(3)
    h.record('v1')
    h.record('v2')
    h.record('v3')
    h.record('v4')
    expect(h.undo('v5')).toBe('v4')
    expect(h.undo('v4')).toBe('v3')
    expect(h.undo('v3')).toBe('v2')
    expect(h.undo('v2')).toBeNull()
  })

  it('clear 清空两个栈', () => {
    const h = new History()
    h.record('v1')
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.undo('x')).toBeNull()
  })
})
