// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutTree, type TextMeasurer } from '../layout/treeLayout'
import { MindmapDocument, resetNodeIdCounter } from '../model/document'
import { nodeGeometry } from './hitTest'
import {
  CanvasRenderer,
  canvasNodeTier,
  descendantCount,
  shouldShowCollapseControl,
} from './canvasRenderer'

const measurer: TextMeasurer = {
  measure(text: string) {
    return { width: text.length * 8, height: 21 }
  },
}

let context: Record<PropertyKey, unknown>

function installCanvasStub(): void {
  context = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 8 })
      if (!(property in target)) target[property] = vi.fn()
      return target[property]
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => context,
  })
}

function createRenderer() {
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 600 },
  })
  document.body.append(host)
  return { host, renderer: new CanvasRenderer(host) }
}

beforeEach(() => {
  resetNodeIdCounter()
  document.body.innerHTML = ''
  vi.useFakeTimers()
  installCanvasStub()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Canvas 节点视觉层级与折叠控件', () => {
  it('根、一级、二级、三级以后映射到四套稳定层级', () => {
    expect([0, 1, 2, 3, 8].map(canvasNodeTier)).toEqual([
      'root',
      'primary',
      'secondary',
      'tertiary',
      'tertiary',
    ])
  })

  it('折叠计数递归包含所有后代，展开控件只在 hover 时出现', () => {
    const doc = new MindmapDocument('T')
    const parent = doc.insertChild(doc.root, 0, 'parent')
    const child = doc.insertChild(parent, 0, 'child')
    doc.insertChild(child, 0, 'grandchild')
    doc.insertChild(parent, 1, 'sibling')

    expect(descendantCount(parent)).toBe(3)
    expect(shouldShowCollapseControl(parent, null)).toBe(false)
    expect(shouldShowCollapseControl(parent, parent.id)).toBe(true)
    parent.collapsed = true
    expect(shouldShowCollapseControl(parent, null)).toBe(true)
    expect(shouldShowCollapseControl(doc.root, doc.root.id)).toBe(true)
  })
})

describe('Canvas 行内链接命中区域', () => {
  it('记录链接文字的世界坐标和原始 Markdown 范围', () => {
    const doc = new MindmapDocument('T')
    const node = doc.insertChild(doc.root, 0, 'before [bridge](https://example.com) after')
    const layout = layoutTree(doc.root, { measurer })
    const box = layout.boxes.get(node.id)!
    const geo = nodeGeometry(box, new Map(), false)
    const { renderer } = createRenderer()
    renderer.setLayout(layout, {
      root: doc.root,
      selection: new Set(),
      matches: new Set(),
      imageAspects: new Map(),
    })

    ;(renderer as unknown as { draw(): void }).draw()
    const hit = renderer.hitInlineLink(
      box.x + geo.textX + 'before '.length * 8 + 2,
      box.y + geo.textY,
    )

    expect(hit).toMatchObject({
      id: node.id,
      url: 'https://example.com',
      rawStart: 7,
      rawEnd: 36,
    })
    expect(hit?.rect.width).toBeGreaterThan(0)
    expect(renderer.hitInlineLink(box.x - 20, box.y - 20)).toBeNull()
    renderer.destroy()
  })
})

describe('Canvas 节点拖动预览', () => {
  it('保留原子树占位，同时绘制浮动副本和候选父级连线', () => {
    const doc = new MindmapDocument('T')
    const source = doc.insertChild(doc.root, 0, 'source')
    const child = doc.insertChild(source, 0, 'child')
    const target = doc.insertChild(doc.root, 1, 'target')
    const layout = layoutTree(doc.root, { measurer })
    const sourceBox = layout.boxes.get(source.id)!
    const targetBox = layout.boxes.get(target.id)!
    const ghostX = targetBox.x + targetBox.width + 96
    const ghostY = targetBox.y + 12
    const { renderer } = createRenderer()
    renderer.setLayout(layout, {
      root: doc.root,
      selection: new Set([source.id]),
      matches: new Set(),
      imageAspects: new Map(),
    })
    renderer.setDragPreview({
      sourceId: source.id,
      pointer: { x: ghostX + 8, y: ghostY + 6 },
      offset: { x: 8, y: 6 },
      indicator: { type: 'child', targetId: target.id },
    })

    ;(renderer as unknown as { draw(): void }).draw()

    const roundRect = context.roundRect as ReturnType<typeof vi.fn>
    const fillText = context.fillText as ReturnType<typeof vi.fn>
    const lineTo = context.lineTo as ReturnType<typeof vi.fn>
    expect(roundRect).toHaveBeenCalledWith(
      sourceBox.x - 3,
      sourceBox.y - 3,
      sourceBox.width + 6,
      sourceBox.height + 6,
      7,
    )
    expect(roundRect).toHaveBeenCalledWith(
      layout.boxes.get(child.id)!.x - 3,
      layout.boxes.get(child.id)!.y - 3,
      layout.boxes.get(child.id)!.width + 6,
      layout.boxes.get(child.id)!.height + 6,
      7,
    )
    expect(fillText.mock.calls.filter(([text]) => text === 'source')).toHaveLength(2)
    expect(lineTo).toHaveBeenCalledWith(ghostX, ghostY + sourceBox.height / 2)
    renderer.destroy()
  })
})
