// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutResult } from './layout/treeLayout'
import { resetNodeIdCounter } from './model/document'
import { CanvasViewer } from './canvasViewer'
import { nodeGeometry } from './render/hitTest'
import { MindmapSession } from './session'

function installCanvasStubs(): void {
  const context = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 8 })
      if (property === 'createLinearGradient') return () => ({ addColorStop: vi.fn() })
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

function mountViewer(markdown = '# T\n\n- parent\n  - child\n') {
  resetNodeIdCounter()
  const session = new MindmapSession({ markdown, fileName: 'preview.tn-mindmap.md' })
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 600 },
  })
  document.body.append(host)
  const viewer = new CanvasViewer(host, session, {
    theme: 'light',
    measurer: { measure: (text) => ({ width: text.length * 8, height: 21 }) },
  })
  return { host, session, viewer }
}

function viewerInternals(viewer: CanvasViewer) {
  return viewer as unknown as {
    controller: {
      layout: LayoutResult
      transform: { x: number; y: number; k: number }
      renderer: { themeMode: string }
    }
  }
}

function nodePoint(viewer: CanvasViewer, id: string) {
  const { controller } = viewerInternals(viewer)
  const box = controller.layout.boxes.get(id)!
  return {
    x: controller.transform.x + (box.x + box.width / 2) * controller.transform.k,
    y: controller.transform.y + (box.y + box.height / 2) * controller.transform.k,
  }
}

function worldPoint(viewer: CanvasViewer, x: number, y: number) {
  const { controller } = viewerInternals(viewer)
  return {
    x: controller.transform.x + x * controller.transform.k,
    y: controller.transform.y + y * controller.transform.k,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  installCanvasStubs()
})

afterEach(() => vi.restoreAllMocks())

describe('CanvasViewer', () => {
  it('double click enters a topic without opening an editor or changing Markdown', () => {
    const { host, session, viewer } = mountViewer()
    const node = session.document.root.children[0]
    const before = session.getMarkdown()
    const point = nodePoint(viewer, node.id)

    host.dispatchEvent(new MouseEvent('dblclick', { clientX: point.x, clientY: point.y, bubbles: true }))

    expect(session.focusRootNode.id).toBe(node.id)
    expect(host.querySelector('.mm-edit-input')).toBeNull()
    expect(session.getMarkdown()).toBe(before)
    viewer.destroy()
  })

  it('blocks editing and destructive keyboard shortcuts', () => {
    const { host, session, viewer } = mountViewer()
    const node = session.document.root.children[0]
    const before = session.getMarkdown()

    session.select(node.id)
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }))
    const point = nodePoint(viewer, node.id)
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: point.x, clientY: point.y, button: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: point.x + 180, clientY: point.y + 80, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: point.x + 180, clientY: point.y + 80, bubbles: true }))
    host.dispatchEvent(new MouseEvent('dblclick', { clientX: point.x, clientY: point.y, bubbles: true }))

    expect(session.getMarkdown()).toBe(before)
    expect(host.querySelector('.mm-edit-input')).toBeNull()
    viewer.destroy()
  })

  it('renders task checkboxes as preview-only controls', () => {
    const { host, session, viewer } = mountViewer('# T\n\n- [ ] task\n')
    const node = session.document.root.children[0]
    const state = viewerInternals(viewer)
    const box = state.controller.layout.boxes.get(node.id)!
    const checkbox = nodeGeometry(box, new Map(), false).checkboxRect!
    const point = worldPoint(viewer, box.x + checkbox.x + checkbox.w / 2, box.y + checkbox.y + checkbox.h / 2)

    host.dispatchEvent(new MouseEvent('click', { clientX: point.x, clientY: point.y, bubbles: true }))

    expect(node.content.checked).toBe(false)
    expect(session.getMarkdown()).toContain('- [ ] task')
    viewer.destroy()
  })

  it('switches the renderer theme without rebuilding the viewer', () => {
    const { viewer } = mountViewer()
    const state = viewerInternals(viewer)
    expect(state.controller.renderer.themeMode).toBe('light')

    viewer.setTheme('dark')

    expect(state.controller.renderer.themeMode).toBe('dark')
    viewer.destroy()
  })
})
