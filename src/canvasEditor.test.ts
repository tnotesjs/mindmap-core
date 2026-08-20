// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasEditor } from './canvasEditor'
import type { CanvasEditorEvents } from './canvasEditor'
import type { LayoutResult } from './layout/treeLayout'
import { resetNodeIdCounter } from './model/document'
import { nodeGeometry } from './render/hitTest'
import { MindmapSession } from './session'

function installCanvasStubs(): void {
  const gradient = { addColorStop: vi.fn() }
  const context = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(target, property) {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 8 })
      if (property === 'createLinearGradient') return () => gradient
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

function mountEditor(markdown = '# T\n\n- alpha\n', events: CanvasEditorEvents = {}) {
  resetNodeIdCounter()
  const session = new MindmapSession({ markdown, fileName: 't.tn-mindmap.md' })
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 700 },
  })
  document.body.append(host)
  const editor = new CanvasEditor(host, session, events, {
    measure: (text) => ({ width: text.length * 8, height: 21 }),
  })
  const node = session.document.root.children[0]
  editor.startEdit(node.id)
  const input = host.querySelector<HTMLTextAreaElement>('.mm-edit-input')!
  return { editor, host, input, node, session }
}

function canvasInternals(editor: CanvasEditor) {
  return editor as unknown as {
    layout: LayoutResult
    transform: { x: number; y: number; k: number }
    renderer: {
      draw(): void
      dragPreview: {
        sourceId: string
        pointer: { x: number; y: number }
        indicator: { type: 'child' | 'before' | 'after'; targetId: string } | null
      } | null
    }
  }
}

function screenPoint(editor: CanvasEditor, id: string, edge: 'center' | 'topLeft' | 'bottomRight' = 'center') {
  const state = canvasInternals(editor)
  const box = state.layout.boxes.get(id)!
  const x = edge === 'topLeft' ? box.x : edge === 'bottomRight' ? box.x + box.width : box.x + box.width / 2
  const y = edge === 'topLeft' ? box.y : edge === 'bottomRight' ? box.y + box.height : box.y + box.height / 2
  return { x: state.transform.x + x * state.transform.k, y: state.transform.y + y * state.transform.k }
}

function screenWorldPoint(editor: CanvasEditor, x: number, y: number) {
  const state = canvasInternals(editor)
  return {
    x: state.transform.x + x * state.transform.k,
    y: state.transform.y + y * state.transform.k,
  }
}

function shortcut(input: HTMLTextAreaElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  input.dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  installCanvasStubs()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('脑图编辑态行内格式快捷键', () => {
  it('进入编辑态时保留组合样式 DOM，而不是退化成纯文本', () => {
    const { editor, input, node } = mountEditor('# T\n\n- ***alpha***\n')
    expect(input.tagName).toBe('DIV')
    expect(input.querySelector('.inline-run.bold.italic')?.textContent).toBe('alpha')
    expect(node.content.raw).toBe('***alpha***')
    editor.destroy()
  })

  it('编辑框外框与 Canvas 节点投影完全对齐', () => {
    const { editor, input, node } = mountEditor()
    const state = canvasInternals(editor)
    const box = state.layout.boxes.get(node.id)!
    expect(parseFloat(input.style.left)).toBeCloseTo(state.transform.x + box.x * state.transform.k)
    expect(parseFloat(input.style.top)).toBeCloseTo(state.transform.y + box.y * state.transform.k)
    expect(parseFloat(input.style.width)).toBeCloseTo(box.width * state.transform.k)
    expect(parseFloat(input.style.height)).toBeCloseTo(box.height * state.transform.k)
    // 一级节点的编辑态必须复用渲染态字号，否则双击瞬间会产生肉眼可见的位移。
    expect(parseFloat(input.style.fontSize)).toBeCloseTo(15 * state.transform.k)
    editor.destroy()
  })

  it('编辑节点时平移画布会同步移动 DOM 覆盖层和新增按钮', () => {
    const { editor, host, input, node } = mountEditor('# T\n\n- alpha beta\n')
    const addButton = host.querySelector<HTMLButtonElement>('.mm-edit-add-button')!
    const beforeInput = { left: parseFloat(input.style.left), top: parseFloat(input.style.top) }
    const beforeAdd = { left: parseFloat(addButton.style.left), top: parseFloat(addButton.style.top) }

    host.dispatchEvent(new WheelEvent('wheel', {
      deltaX: 80,
      deltaY: -45,
      bubbles: true,
      cancelable: true,
    }))

    const projected = screenPoint(editor, node.id, 'topLeft')
    expect(parseFloat(input.style.left)).toBeCloseTo(beforeInput.left - 80)
    expect(parseFloat(input.style.top)).toBeCloseTo(beforeInput.top + 45)
    expect(parseFloat(input.style.left)).toBeCloseTo(projected.x)
    expect(parseFloat(input.style.top)).toBeCloseTo(projected.y)
    expect(parseFloat(addButton.style.left)).toBeCloseTo(beforeAdd.left - 80)
    expect(parseFloat(addButton.style.top)).toBeCloseTo(beforeAdd.top + 45)
    expect(host.querySelectorAll('.mm-edit-input')).toHaveLength(1)
    editor.destroy()
  })

  it('编辑节点时缩放画布会同步覆盖层位置、尺寸和字号', () => {
    const { editor, input, node } = mountEditor('# T\n\n- alpha beta\n')
    const beforeWidth = parseFloat(input.style.width)
    const beforeFontSize = parseFloat(input.style.fontSize)

    editor.zoomBy(1.2)

    const state = canvasInternals(editor)
    const projected = screenPoint(editor, node.id, 'topLeft')
    expect(parseFloat(input.style.left)).toBeCloseTo(projected.x)
    expect(parseFloat(input.style.top)).toBeCloseTo(projected.y)
    expect(parseFloat(input.style.width)).toBeGreaterThan(beforeWidth)
    expect(parseFloat(input.style.fontSize)).toBeGreaterThan(beforeFontSize)
    expect(parseFloat(input.style.fontSize)).toBeCloseTo(15 * state.transform.k)
    editor.destroy()
  })

  it('短主题输入一个字符时横向增长，不会提前折成第二行', () => {
    const { editor, input } = mountEditor('# T\n\n- 明确目标\n')
    const initialWidth = parseFloat(input.style.width)
    const initialHeight = parseFloat(input.style.height)

    input.value = `${input.value}s`

    expect(input.value).toBe('明确目标s')
    expect(parseFloat(input.style.width)).toBeGreaterThan(initialWidth)
    expect(parseFloat(input.style.height)).toBe(initialHeight)
    editor.destroy()
  })

  it.each([
    ['b', false, '**alpha**'],
    ['i', false, '*alpha*'],
    ['u', false, '<u>alpha</u>'],
    ['s', true, '~~alpha~~'],
    ['h', true, '==alpha=='],
    ['e', false, '`alpha`'],
  ])('Cmd+%s 切换格式并保持选区', (key, shiftKey, expectedRaw) => {
    const { editor, input, node } = mountEditor()
    input.setSelectionRange(0, input.value.length)

    const event = shortcut(input, key, shiftKey)

    expect(event.defaultPrevented).toBe(true)
    expect(node.content.raw).toBe(expectedRaw)
    expect(input.value).toBe('alpha')
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
    editor.destroy()
  })

  it('格式化前同步刚输入的文案，撤销时先撤格式再撤输入', () => {
    const { editor, input, node, session } = mountEditor()
    input.value = 'alpha beta'
    input.setSelectionRange(6, 10)

    shortcut(input, 'b')
    expect(node.content.raw).toBe('alpha **beta**')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    session.undo()
    expect(session.document.find(node.id)?.content.raw).toBe('alpha beta')
    session.undo()
    expect(session.document.find(node.id)?.content.raw).toBe('alpha')
    editor.destroy()
  })

  it('使用 Cmd+Enter 删除线、Cmd+E 行内代码，并让 Option+L 保持为系统输入', () => {
    const first = mountEditor()
    first.input.setSelectionRange(0, first.input.value.length)
    shortcut(first.input, 'Enter')
    expect(first.node.content.raw).toBe('~~alpha~~')
    expect(document.activeElement).toBe(first.input)
    first.editor.destroy()

    const second = mountEditor()
    second.input.setSelectionRange(0, second.input.value.length)
    const codeEvent = new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true, cancelable: true })
    second.input.dispatchEvent(codeEvent)
    expect(codeEvent.defaultPrevented).toBe(true)
    expect(second.node.content.raw).toBe('`alpha`')

    const altL = new KeyboardEvent('keydown', { key: 'l', altKey: true, bubbles: true, cancelable: true })
    second.input.dispatchEvent(altL)
    expect(altL.defaultPrevented).toBe(false)
    expect(second.node.content.raw).toBe('`alpha`')
    second.editor.destroy()
  })

  it.each([
    ['b', '**alpha**'],
    ['e', '`alpha`'],
  ])('没有文本选区时 Cmd+%s 格式化整个编辑节点并保留光标', (key, expectedRaw) => {
    const { editor, input, node } = mountEditor()
    input.setSelectionRange(2, 2)

    shortcut(input, key)

    expect(node.content.raw).toBe(expectedRaw)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2])
    editor.destroy()
  })

  it('Cmd+\\ 清除选区样式并保持编辑焦点', () => {
    const { editor, input, node } = mountEditor('# T\n\n- ***alpha***\n')
    input.setSelectionRange(0, input.value.length)
    shortcut(input, '\\')
    expect(node.content.raw).toBe('alpha')
    expect(document.activeElement).toBe(input)
    editor.destroy()
  })

  it('没有文本选区时 Cmd+\\ 清除整个节点样式并保留光标', () => {
    const { editor, input, node } = mountEditor('# T\n\n- ***alpha***\n')
    input.setSelectionRange(2, 2)
    shortcut(input, '\\')
    expect(node.content.raw).toBe('alpha')
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2])
    editor.destroy()
  })

  it('没有文本选区时 Cmd+Enter 新增子主题并继续编辑', () => {
    const { editor, host, input, node } = mountEditor()
    input.setSelectionRange(2, 2)
    shortcut(input, 'Enter')

    expect(node.children).toHaveLength(1)
    expect(host.querySelector<HTMLTextAreaElement>('.mm-edit-input')).not.toBe(input)
    expect(document.activeElement).toBe(host.querySelector('.mm-edit-input'))
    editor.destroy()
  })
})

describe('脑图导航、框选与离散多选', () => {
  it('拖动期间只显示预览，松手后才提交树结构移动', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- a\n- b\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const [a, b] = session.document.root.children
    const source = screenPoint(editor, b.id)
    const target = screenPoint(editor, a.id)

    host.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: source.x,
      clientY: source.y,
      button: 0,
      bubbles: true,
    }))
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: target.x,
      clientY: target.y,
      bubbles: true,
    }))

    expect(b.parent).toBe(session.document.root)
    expect(canvasInternals(editor).renderer.dragPreview).toMatchObject({
      sourceId: b.id,
      indicator: { type: 'child', targetId: a.id },
    })
    expect(host.classList.contains('is-node-dragging')).toBe(true)

    window.dispatchEvent(new PointerEvent('pointerup', {
      clientX: target.x,
      clientY: target.y,
      bubbles: true,
    }))
    expect(b.parent).toBe(a)
    expect(canvasInternals(editor).renderer.dragPreview).toBeNull()
    expect(host.classList.contains('is-node-dragging')).toBe(false)
    editor.destroy()
  })

  it('上下键优先切换同级节点，不落入中间高度的子节点', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- 生活标准\n  - 很高的子节点\n- 工作原则\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const life = session.document.root.children[0]
    const work = session.document.root.children[1]
    session.select(life.id)
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(session.selectedNode).toBe(work)
    editor.destroy()
  })

  it('空白拖动框选相交节点，按 Space 拖动才平移', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- a\n- b\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const [a, b] = session.document.root.children
    const pa = screenPoint(editor, a.id, 'topLeft')
    const pb = screenPoint(editor, b.id, 'bottomRight')
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: pa.x - 8, clientY: pa.y - 8, button: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: pb.x + 8, clientY: pb.y + 8, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: pb.x + 8, clientY: pb.y + 8, bubbles: true }))
    expect(session.selectionIds.has(a.id)).toBe(true)
    expect(session.selectionIds.has(b.id)).toBe(true)

    const before = { ...canvasInternals(editor).transform }
    host.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: 2, clientY: 2, button: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 42, clientY: 32, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 42, clientY: 32, bubbles: true }))
    expect(canvasInternals(editor).transform.x).toBe(before.x + 40)
    expect(canvasInternals(editor).transform.y).toBe(before.y + 30)
    editor.destroy()
  })

  it('Cmd 点击切换离散节点选择，并可批量应用格式', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- a\n- b\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const [a, b] = session.document.root.children
    session.select(null)
    for (const node of [a, b]) {
      const point = screenPoint(editor, node.id)
      host.dispatchEvent(new PointerEvent('pointerdown', { clientX: point.x, clientY: point.y, button: 0, metaKey: true, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: point.x, clientY: point.y, bubbles: true }))
      host.dispatchEvent(new MouseEvent('click', { clientX: point.x, clientY: point.y, metaKey: true, bubbles: true }))
    }
    expect(new Set(session.selectionIds)).toEqual(new Set([a.id, b.id]))
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }))
    expect(a.content.raw).toBe('**a**')
    expect(b.content.raw).toBe('**b**')
    editor.destroy()
  })

  it('Cmd+] 进入任意已选节点', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- a\n  - a1\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const a = session.document.root.children[0]
    session.select(a.id)
    host.dispatchEvent(new KeyboardEvent('keydown', { key: ']', metaKey: true, bubbles: true, cancelable: true }))
    expect(session.focusRootNode).toBe(a)
    editor.destroy()
  })

  it('真实键值 “>” 也能触发 Cmd+Shift+. 的同级折叠', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- a\n  - a1\n- b\n  - b1\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const [a, b] = session.document.root.children
    session.select(a.id)

    host.dispatchEvent(new KeyboardEvent('keydown', {
      key: '>',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))

    expect(a.collapsed).toBe(true)
    expect(b.collapsed).toBe(true)
    editor.destroy()
  })
})

describe('脑图链接 hover', () => {
  it('仅悬停精确链接文字约 380ms 后发出链接编辑浮层位置', () => {
    vi.useFakeTimers()
    const onLinkHover = vi.fn()
    const { editor, input, node } = mountEditor('# T\n\n- before [桥水官网](https://bridgewater.com) after\n', { onLinkHover })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const state = canvasInternals(editor)
    state.renderer.draw()
    const box = state.layout.boxes.get(node.id)!
    const geo = nodeGeometry(box, new Map(), false)

    const plainPoint = screenWorldPoint(editor, box.x + geo.textX + 2, box.y + geo.textY)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: plainPoint.x, clientY: plainPoint.y, bubbles: true }))
    vi.advanceTimersByTime(400)
    expect(onLinkHover).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: node.id }))

    const linkPoint = screenWorldPoint(editor, box.x + geo.textX + 'before '.length * 8 + 2, box.y + geo.textY)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: linkPoint.x, clientY: linkPoint.y, bubbles: true }))
    vi.advanceTimersByTime(400)
    expect(onLinkHover).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: node.id,
      url: 'https://bridgewater.com',
    }))

    const popover = document.createElement('div')
    popover.className = 'link-popover'
    document.body.append(popover)
    popover.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }))
    expect(onLinkHover).not.toHaveBeenLastCalledWith(null)
    editor.destroy()
    vi.useRealTimers()
  })

  it('单击链接文字在新标签页打开，单击同一节点普通文案不会跳转', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { editor, host, input, node } = mountEditor('# T\n\n- before [桥水官网](https://bridgewater.com) after\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const state = canvasInternals(editor)
    state.renderer.draw()
    const box = state.layout.boxes.get(node.id)!
    const geo = nodeGeometry(box, new Map(), false)

    const plainPoint = screenWorldPoint(editor, box.x + geo.textX + 2, box.y + geo.textY)
    host.dispatchEvent(new MouseEvent('click', { clientX: plainPoint.x, clientY: plainPoint.y, bubbles: true }))
    expect(open).not.toHaveBeenCalled()

    const linkPoint = screenWorldPoint(editor, box.x + geo.textX + 'before '.length * 8 + 2, box.y + geo.textY)
    host.dispatchEvent(new MouseEvent('click', { clientX: linkPoint.x, clientY: linkPoint.y, bubbles: true }))
    expect(open).toHaveBeenCalledWith('https://bridgewater.com', '_blank', 'noopener,noreferrer')
    editor.destroy()
  })
})

describe('脑图折叠控件 hover', () => {
  it('展开节点的圆环只在 hover 后可点击，并折叠全部子树', () => {
    const { editor, host, input, session } = mountEditor('# T\n\n- parent\n  - child\n    - grandchild\n')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const parent = session.document.root.children[0]
    // 单选节点优先显示新增按钮；取消选中后再验证普通 hover 的收起按钮。
    session.select(null)
    const state = canvasInternals(editor)
    const box = state.layout.boxes.get(parent.id)!
    const body = screenWorldPoint(editor, box.x + 3, box.y + box.height / 2)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: body.x, clientY: body.y, bubbles: true }))

    const dot = nodeGeometry(box, new Map(), false).collapseDot!
    const ring = screenWorldPoint(editor, dot.cx + 5, dot.cy)
    host.dispatchEvent(new MouseEvent('click', { clientX: ring.x, clientY: ring.y, bubbles: true }))
    expect(parent.collapsed).toBe(true)
    expect(canvasInternals(editor).layout.boxes.has(parent.children[0].id)).toBe(false)
    editor.destroy()
  })

  it('编辑节点时右侧加号跟随输入框，并可新增子主题后立即编辑', () => {
    const { editor, host, input, node } = mountEditor()
    const addButton = host.querySelector<HTMLButtonElement>('.mm-edit-add-button')!
    const initialLeft = parseFloat(addButton.style.left)

    input.value = `${input.value} beta`
    expect(parseFloat(addButton.style.left)).toBeGreaterThan(initialLeft)

    addButton.click()

    expect(node.children).toHaveLength(1)
    const nextInput = host.querySelector<HTMLElement>('.mm-edit-input')
    expect(nextInput).not.toBe(input)
    expect(document.activeElement).toBe(nextInput)
    editor.destroy()
  })

  it('单选节点的 Canvas 加号新增子主题并立即进入编辑', () => {
    const { editor, host, input, node } = mountEditor()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const state = canvasInternals(editor)
    const box = state.layout.boxes.get(node.id)!
    const add = nodeGeometry(box, new Map(), true).controlDot!
    const point = screenWorldPoint(editor, add.cx, add.cy)

    host.dispatchEvent(new MouseEvent('click', { clientX: point.x, clientY: point.y, bubbles: true }))

    expect(node.children).toHaveLength(1)
    expect(document.activeElement).toBe(host.querySelector('.mm-edit-input'))
    editor.destroy()
  })
})

describe('脑图节点底部菜单定位', () => {
  it('单选节点后也发出画布底部居中的菜单位置', () => {
    const onSelectionPositionChange = vi.fn()
    const { editor } = mountEditor('# T\n\n- alpha\n', { onSelectionPositionChange })

    expect(onSelectionPositionChange).toHaveBeenLastCalledWith({ left: 500, top: 682 }, 1)
    editor.destroy()
  })
})

describe('脑图节点剪贴板快捷键', () => {
  it.each([
    ['c', 'onCopySelection'],
    ['x', 'onCutSelection'],
  ] as const)('节点选择态 Cmd+%s 发出对应剪贴板请求', (key, eventName) => {
    const events = {
      onCopySelection: vi.fn(),
      onCutSelection: vi.fn(),
    }
    const { editor, host, input } = mountEditor('# T\n\n- alpha\n', events)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })

    host.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(events[eventName]).toHaveBeenCalledOnce()
    editor.destroy()
  })
})

describe('脑图节点右键菜单', () => {
  it('右键未选节点改为单选并发出单主题菜单能力', () => {
    const onContextMenu = vi.fn()
    const { editor, host, input, node, session } = mountEditor('# T\n\n- alpha\n- beta\n', { onContextMenu })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const beta = session.document.root.children[1]
    const point = screenPoint(editor, beta.id)

    const event = new MouseEvent('contextmenu', {
      button: 2,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    })
    host.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(session.selectedNode).toBe(beta)
    expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: beta.id,
      position: { left: point.x, top: point.y },
      multiple: false,
      canInsertSibling: true,
      canDeleteOnly: true,
      canFocus: true,
    }))
    expect(node).not.toBe(session.selectedNode)
    editor.destroy()
  })

  it('右键已选节点保留离散多选并发出多主题菜单', () => {
    const onContextMenu = vi.fn()
    const { editor, host, input, session } = mountEditor('# T\n\n- alpha\n- beta\n', { onContextMenu })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const [alpha, beta] = session.document.root.children
    session.selectMany([alpha.id, beta.id], beta.id, alpha.id)
    const point = screenPoint(editor, alpha.id)

    host.dispatchEvent(new MouseEvent('contextmenu', {
      button: 2,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    }))

    expect([...session.selectionIds]).toEqual([alpha.id, beta.id])
    expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: alpha.id, multiple: true }))
    editor.destroy()
  })

  it('右键当前根主题时禁用无效的剪切、副本、删除和同级折叠', () => {
    const onContextMenu = vi.fn()
    const { editor, host, input, session } = mountEditor('# T\n\n- alpha\n', { onContextMenu })
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const root = session.document.root
    const point = screenPoint(editor, root.id)

    host.dispatchEvent(new MouseEvent('contextmenu', {
      button: 2,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    }))

    expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: root.id,
      canCut: false,
      canDuplicate: false,
      canDeleteOnly: false,
      canDeleteTree: false,
      canToggleSiblings: false,
      canFocus: false,
    }))
    editor.destroy()
  })
})

describe('脑图编辑态链接与待办快捷键', () => {
  it('编辑链接节点只展示 label，提交文案时保留 href', () => {
    const { editor, input, node } = mountEditor('# T\n\n- [label](https://old.example)\n')
    expect(input.value).toBe('label')

    input.value = 'renamed'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    expect(node.content.raw).toBe('[renamed](https://old.example)')
    editor.destroy()
  })

  it('Cmd+K 为选中文字添加链接，留空时移除链接', () => {
    const { editor, input, node } = mountEditor()
    const prompt = vi.fn()
      .mockReturnValueOnce('https://new.example')
      .mockReturnValueOnce('')
    Object.defineProperty(window, 'prompt', { configurable: true, value: prompt })
    input.setSelectionRange(0, input.value.length)

    shortcut(input, 'k')
    expect(node.content.raw).toBe('[alpha](https://new.example)')
    expect(input.value).toBe('alpha')
    expect(document.activeElement).toBe(input)

    shortcut(input, 'k')
    expect(prompt).toHaveBeenLastCalledWith('链接地址（留空可移除链接）', 'https://new.example')
    expect(node.content.raw).toBe('alpha')
    editor.destroy()
  })

  it('Cmd+Shift+L 把当前主题转换为待办', () => {
    const { editor, input, node } = mountEditor()
    shortcut(input, 'l', true)
    expect(node.content.checked).toBe(false)
    editor.destroy()
  })
})
