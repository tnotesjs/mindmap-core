/**
 * CanvasEditor：脑图视图控制器。
 * 绑定无头会话 MindmapSession，负责 Canvas 渲染调度、键鼠交互与内联编辑。
 * 只在脑图视图激活时创建，视图切换走即销毁；全部文档状态保存在 session 中。
 */

import {
  CHECKBOX_WIDTH,
  DEFAULT_COLUMN_WIDTH,
  layoutTree,
  NODE_MAX_WIDTH,
  NODE_PAD_X,
  NODE_PAD_Y,
  TEXT_LINE_HEIGHT,
  wrapTextLines,
} from './layout/treeLayout'
import type { LayoutResult, TextMeasurer } from './layout/treeLayout'
import { isAncestor, snapshotDoc, visibleChildren } from './model/document'
import type { MindmapNode } from './model/document'
import {
  parseInlineSegments,
  replaceInlineDisplayText,
  replaceInlineRange,
  stripInline,
} from './model/inline'
import type { InlineFormat } from './model/inline'
import { CanvasRenderer, canvasNodeTier } from './render/canvasRenderer'
import type { CanvasDragPreview, DropIndicator, ViewTransform } from './render/canvasRenderer'
import { hitTest } from './render/hitTest'
import type { MindmapSession } from './session'
import {
  nextGraphemeOffset,
  previousGraphemeOffset,
  richSelectionOffsets,
  setRichSelection,
} from './dom/richInlineDom'

interface CanvasRichEditorElement extends HTMLDivElement {
  value: string
  readonly rawValue: string
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange(start: number, end: number): void
}

export interface CanvasLinkHover {
  nodeId: string
  url: string
  rawStart: number
  rawEnd: number
  position: { left: number; top: number }
}

export interface CanvasContextRequest {
  nodeId: string
  position: { left: number; top: number }
  multiple: boolean
  canInsertSibling: boolean
  canInsertParent: boolean
  canCut: boolean
  canDuplicate: boolean
  canDeleteOnly: boolean
  canDeleteTree: boolean
  canToggleSiblings: boolean
  canFocus: boolean
}

function renderCanvasInlineRuns(root: HTMLElement, raw: string, sourceMode = false): void {
  if (sourceMode) {
    root.textContent = raw
    return
  }
  const fragment = document.createDocumentFragment()
  for (const segment of parseInlineSegments(raw)) {
    const run = document.createElement('span')
    run.className = 'inline-run'
    for (const format of ['bold', 'italic', 'underline', 'strike', 'highlight', 'code'] as const) {
      if (segment.marks[format]) run.classList.add(format)
    }
    if (segment.link) run.classList.add('link')
    run.textContent = segment.text
    fragment.append(run)
  }
  root.replaceChildren(fragment)
}

export interface CanvasEditorEvents {
  /** 请求打开搜索（Cmd/Ctrl+F） */
  onRequestSearch?: () => void
  /** 点击图片节点 */
  onImagePreview?: (src: string) => void
  /** 在当前节点粘贴剪贴板图片 */
  onPasteImage?: (anchorId: string, blob: Blob) => void
  /** 将 Markdown 中的相对资源路径解析为浏览器可加载 URL。 */
  resolveImageSrc?: (src: string) => string
  /** 单选/多选节点工具栏的屏幕位置。 */
  onSelectionPositionChange?: (position: { left: number; top: number } | null, count: number) => void
  /** Canvas 链接悬停编辑浮层。null 表示指针离开链接。 */
  onLinkHover?: (link: CanvasLinkHover | null) => void
  /** 节点右键菜单。null 表示关闭当前菜单。 */
  onContextMenu?: (request: CanvasContextRequest | null) => void
}

export function createCanvasMeasurer(font = `14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`): TextMeasurer {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  return {
    measure(text: string) {
      return { width: ctx.measureText(text).width, height: 21 }
    },
  }
}

const MIN_SCALE = 0.1
const MAX_SCALE = 3

export class CanvasEditor {
  private renderer: CanvasRenderer
  private layout!: LayoutResult
  private transform: ViewTransform = { x: 40, y: 40, k: 1 }
  private measurer: TextMeasurer
  private imageAspects = new Map<string, number>()

  private overlay: HTMLDivElement
  private editingInput: CanvasRichEditorElement | null = null
  private editingAddButton: HTMLButtonElement | null = null
  private editingNode: MindmapNode | null = null
  private editingDraftRaw = ''
  private editingInitialDisplayText = ''
  private editingComposing = false
  private editingCompositionBaseRaw = ''
  private suspendEditingBlur = false

  private dragState: {
    id: string
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    dragging: boolean
  } | null = null
  private panState: { startX: number; startY: number; baseX: number; baseY: number } | null = null
  private panMoved = false
  private spacePressed = false
  private selectionBoxState: { startX: number; startY: number; currentX: number; currentY: number; moved: boolean } | null = null
  private selectionBoxEl: HTMLDivElement | null = null
  private resizeState: { id: string; snapshot: string; moved: boolean } | null = null
  private suppressClick = false
  private currentIndicator: DropIndicator | null = null
  private hoveredNodeId: string | null = null
  private pendingLinkKey: string | null = null
  private linkHoverTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private container: HTMLElement,
    private session: MindmapSession,
    private events: CanvasEditorEvents = {},
    measurer?: TextMeasurer,
  ) {
    this.measurer = measurer ?? createCanvasMeasurer()

    container.classList.add('mm-editor')
    container.tabIndex = 0
    this.overlay = document.createElement('div')
    this.overlay.className = 'mm-overlay'

    this.renderer = new CanvasRenderer(container, (src) => this.events.resolveImageSrc?.(src) ?? src)
    this.renderer.onImageLoad = (src, aspect) => {
      this.imageAspects.set(src, aspect)
      this.relayout()
    }
    container.append(this.overlay)

    container.addEventListener('pointerdown', this.onPointerDown)
    container.addEventListener('click', this.onClick)
    container.addEventListener('dblclick', this.onDblClick)
    container.addEventListener('contextmenu', this.onContextMenu)
    container.addEventListener('keydown', this.onKeydown)
    container.addEventListener('keyup', this.onKeyup)
    container.addEventListener('paste', this.onPaste)
    container.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('resize', this.onViewportResize)

    session.on('change', this.onSessionChange)
    session.on('collapseChange', this.onSessionViewChange)
    session.on('focusChange', this.onSessionFocusChange)
    session.on('selectionChange', this.onSessionSelectionChange)
    session.on('matchChange', this.onSessionViewChange)

    this.relayout()
    // 初始 transform 立即同步；rAF 在后台标签页会暂停，加 setTimeout 兜底
    this.setTransform(this.transform)
    const initialFit = () => this.zoomToFit()
    requestAnimationFrame(initialFit)
    setTimeout(initialFit, 60)
  }

  // ---------- session 事件 ----------

  private onSessionChange = (): void => {
    this.relayout()
  }

  private onSessionViewChange = (): void => {
    this.relayout()
  }

  private onSessionFocusChange = (): void => {
    this.relayout()
    this.zoomToFit()
  }

  private onSessionSelectionChange = (): void => {
    this.pushRenderState()
    this.emitSelectionPosition()
  }

  // ---------- 渲染 ----------

  private relayout(): void {
    const root = this.session.focusRootNode
    this.layout = layoutTree(this.session.document.root, {
      measurer: this.measurer,
      imageAspects: this.imageAspects,
      root,
    })
    this.pushRenderState()
    this.syncEditingOverlayGeometry()
  }

  private pushRenderState(): void {
    if (!this.layout) return
    this.renderer.setLayout(this.layout, {
      root: this.session.focusRootNode,
      selection: new Set(this.session.selectionIds),
      matches: new Set(this.session.matches),
      imageAspects: this.imageAspects,
    })
    this.emitSelectionPosition()
  }

  private setTransform(t: ViewTransform): void {
    this.transform = t
    this.renderer.setTransform(t)
    this.syncEditingOverlayGeometry()
    this.emitSelectionPosition()
  }

  /**
   * 编辑层是 DOM，节点本体是 Canvas；任何平移、缩放或重新布局都必须用同一份
   * world → screen 变换同步二者，否则覆盖层会停在旧坐标，看起来像复制了节点。
   */
  private syncEditingOverlayGeometry = (): void => {
    const input = this.editingInput
    const addButton = this.editingAddButton
    const node = this.editingNode
    if (!input || !node) return
    const box = this.layout?.boxes.get(node.id)
    if (!box) return

    const { k, x, y } = this.transform
    const tier = canvasNodeTier(box.depth)
    const fontSize = tier === 'root' ? 16 : tier === 'primary' ? 15 : tier === 'secondary' ? 14.5 : 14
    const fontWeight = tier === 'root' ? 700 : tier === 'primary' ? 600 : tier === 'secondary' ? 500 : 400
    const checkboxPad = node.content.checked !== null && node !== this.session.focusRootNode ? CHECKBOX_WIDTH : 0
    const widthLimit = node !== this.session.focusRootNode && node.children.length > 0
      ? DEFAULT_COLUMN_WIDTH
      : NODE_MAX_WIDTH
    const textMax = widthLimit - NODE_PAD_X * 2 - checkboxPad
    const textScale = tier === 'root' ? 1.2 : tier === 'primary' ? 1.12 : tier === 'secondary' ? 1.08 : 1.06
    const measureWidth = (text: string) => this.measurer.measure(text).width * textScale
    const displayText = input.value || ' '
    const lines = wrapTextLines(displayText, textMax, measureWidth)
    const textW = Math.max(...lines.map(measureWidth))
    const worldWidth = Math.min(widthLimit, Math.max(box.width, textW + NODE_PAD_X * 2 + checkboxPad))
    const worldHeight = Math.max(box.height, lines.length * TEXT_LINE_HEIGHT + NODE_PAD_Y * 2)
    const caretReserve = displayText !== this.editingInitialDisplayText && worldWidth < widthLimit ? 4 : 0

    const left = box.x * k + x
    const top = box.y * k + y
    const width = worldWidth * k + caretReserve
    let height = worldHeight * k
    input.style.left = `${left}px`
    input.style.top = `${top}px`
    input.style.width = `${width}px`
    input.style.height = `${height}px`
    input.style.fontSize = `${fontSize * k}px`
    input.style.fontWeight = String(fontWeight)
    input.style.lineHeight = `${TEXT_LINE_HEIGHT * k}px`
    input.style.paddingTop = `${Math.max(0, NODE_PAD_Y * k - 2)}px`
    input.style.paddingBottom = `${Math.max(0, NODE_PAD_Y * k - 2)}px`
    input.style.paddingLeft = `${Math.max(0, (NODE_PAD_X + checkboxPad) * k - 2)}px`
    input.style.paddingRight = `${Math.max(0, NODE_PAD_X * k - 2)}px`
    // CSS 字重、斜体或代码徽标可能比纯文本测量略宽，从而多折一行；不能裁掉最后一行。
    if (input.scrollHeight > height) {
      height = input.scrollHeight
      input.style.height = `${height}px`
    }
    if (addButton) {
      addButton.style.left = `${left + width - 10}px`
      addButton.style.top = `${top + height / 2 - 10}px`
    }
  }

  private emitSelectionPosition(): void {
    const ids = this.session.selectionIds
    if (ids.size === 0) {
      this.events.onSelectionPositionChange?.(null, ids.size)
      return
    }
    // 脑图节点菜单固定贴近画布底部居中；单选与多选都保持稳定，缩放/平移不会让菜单跳动。
    const rect = this.container.getBoundingClientRect()
    const width = rect.width || this.container.clientWidth
    const height = rect.height || this.container.clientHeight
    this.events.onSelectionPositionChange?.({
      left: rect.left + width / 2,
      top: rect.top + height - 18,
    }, ids.size)
  }

  private onViewportResize = (): void => {
    this.emitSelectionPosition()
  }

  // ---------- 视图控制 ----------

  zoomToFit(): void {
    const cw = this.container.clientWidth
    const ch = this.container.clientHeight
    if (!cw || !ch || !this.layout || this.layout.boxes.size === 0) return
    const pad = 80
    const k = Math.min(cw / (this.layout.width + pad), ch / (this.layout.height + pad), 1.25)
    // 适配允许低于手动缩放下限（巨型脑图也能一屏看全）
    const clamped = Math.min(Math.max(k, 0.02), MAX_SCALE)
    this.setTransform({
      x: (cw - this.layout.width * clamped) / 2,
      y: (ch - this.layout.height * clamped) / 2,
      k: clamped,
    })
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.container.clientWidth / 2, this.container.clientHeight / 2, factor)
  }

  getScale(): number {
    return this.transform.k
  }

  /** 展开祖先、居中并选中（搜索/大纲定位） */
  centerOnNode(id: string, select = true): void {
    this.session.expandAncestors(id)
    if (select) this.session.select(id)
    const box = this.layout.boxes.get(id)
    if (!box) return
    const cw = this.container.clientWidth
    const ch = this.container.clientHeight
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    this.setTransform({
      x: cw / 2 - cx * this.transform.k,
      y: ch / 2 - cy * this.transform.k,
      k: this.transform.k,
    })
  }

  /** 折叠/展开并保持被操作节点屏幕位置不动 */
  private toggleCollapseWithCompensation(id: string): void {
    const oldBox = this.layout.boxes.get(id)
    this.session.toggleCollapse(id)
    if (oldBox) {
      const newBox = this.layout.boxes.get(id)
      if (newBox) {
        const dx = newBox.x - oldBox.x
        const dy = newBox.y - oldBox.y
        if (dx !== 0 || dy !== 0) {
          this.setTransform({
            ...this.transform,
            x: this.transform.x - dx * this.transform.k,
            y: this.transform.y - dy * this.transform.k,
          })
        }
      }
    }
  }

  // ---------- 内联编辑 ----------

  startEdit(id: string): void {
    const node = this.session.document.find(id)
    const box = this.layout.boxes.get(id)
    if (!node || !box || this.editingInput) return

    this.hoveredNodeId = null
    this.renderer.setHoveredNode(null)
    this.pendingLinkKey = null
    if (this.linkHoverTimer) clearTimeout(this.linkHoverTimer)
    this.linkHoverTimer = null
    this.events.onLinkHover?.(null)
    this.session.select(id)
    const input = document.createElement('div') as CanvasRichEditorElement
    input.className = 'mm-edit-input'
    const tier = canvasNodeTier(box.depth)
    input.classList.add(`is-${tier}`)
    input.contentEditable = 'true'
    input.setAttribute('role', 'textbox')
    input.setAttribute('aria-multiline', 'false')
    input.spellcheck = false
    this.overlay.append(input)
    const addButton = document.createElement('button')
    addButton.type = 'button'
    addButton.className = 'mm-edit-add-button'
    addButton.setAttribute('aria-label', '新增子主题')
    addButton.title = '新增子主题 (Tab)'
    addButton.textContent = '+'
    this.overlay.append(addButton)
    this.editingInput = input
    this.editingAddButton = addButton
    this.editingNode = node
    this.editingDraftRaw = node.content.raw
    this.editingCompositionBaseRaw = node.content.raw

    Object.defineProperties(input, {
      value: {
        configurable: true,
        get: () => node.content.image ? this.editingDraftRaw : stripInline(this.editingDraftRaw),
        set: (next: string) => {
          const value = String(next)
          this.renderEditingDraft(node.content.image
            ? value
            : replaceInlineDisplayText(this.editingDraftRaw, value))
        },
      },
      rawValue: { configurable: true, get: () => this.editingDraftRaw },
      selectionStart: { configurable: true, get: () => richSelectionOffsets(input)?.start ?? 0 },
      selectionEnd: { configurable: true, get: () => richSelectionOffsets(input)?.end ?? 0 },
    })
    input.setSelectionRange = (start: number, end: number) => setRichSelection(input, start, end)
    renderCanvasInlineRuns(input, this.editingDraftRaw, !!node.content.image)
    this.editingInitialDisplayText = input.value
    this.syncEditingOverlayGeometry()
    input.addEventListener('draft-render', this.syncEditingOverlayGeometry)

    input.addEventListener('beforeinput', (event) => {
      const e = event as InputEvent
      if (this.editingComposing || e.isComposing) return
      const selection = richSelectionOffsets(input)
      if (!selection) return
      const visible = input.value
      let start = selection.start
      let end = selection.end
      let inserted: string | null = null
      if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') inserted = e.data
      else if (e.inputType === 'deleteContentBackward') {
        start = start === end ? previousGraphemeOffset(visible, start) : start
        inserted = ''
      } else if (e.inputType === 'deleteContentForward') {
        end = start === end ? nextGraphemeOffset(visible, end) : end
        inserted = ''
      } else if (e.inputType === 'deleteByCut') inserted = ''
      else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault()
        return
      }
      if (inserted === null) return
      e.preventDefault()
      const next = node.content.image
        ? `${visible.slice(0, start)}${inserted}${visible.slice(end)}`
        : replaceInlineRange(this.editingDraftRaw, start, end, inserted)
      this.renderEditingDraft(next, start + inserted.length)
    })
    input.addEventListener('input', (event) => {
      if (this.editingComposing || (event as InputEvent).isComposing) return
      const nextText = (input.textContent ?? '').replace(/[\r\n]/g, '')
      const next = node.content.image
        ? nextText
        : replaceInlineDisplayText(this.editingDraftRaw, nextText)
      const selection = richSelectionOffsets(input)
      this.renderEditingDraft(next, selection?.start, selection?.end)
    })
    input.addEventListener('compositionstart', () => {
      this.editingComposing = true
      this.editingCompositionBaseRaw = this.editingDraftRaw
    })
    input.addEventListener('compositionend', () => {
      const nextText = (input.textContent ?? '').replace(/[\r\n]/g, '')
      const selection = richSelectionOffsets(input)
      this.editingComposing = false
      const next = node.content.image
        ? nextText
        : replaceInlineDisplayText(this.editingCompositionBaseRaw, nextText)
      this.renderEditingDraft(next, selection?.start, selection?.end)
    })
    input.addEventListener('paste', (event) => {
      event.preventDefault()
      const plain = event.clipboardData?.getData('text/plain')?.replace(/\r?\n/g, ' ') ?? ''
      const selection = richSelectionOffsets(input)
      if (!selection) return
      const next = node.content.image
        ? `${input.value.slice(0, selection.start)}${plain}${input.value.slice(selection.end)}`
        : replaceInlineRange(this.editingDraftRaw, selection.start, selection.end, plain)
      this.renderEditingDraft(next, selection.start + plain.length)
    })

    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.isComposing || this.editingComposing) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      if (mod && key === '\\' && !node.content.image) {
        e.preventDefault()
        this.clearEditingInlineFormats()
      } else {
        const format = this.inlineFormatShortcut(e, input.selectionStart !== input.selectionEnd)
        if (format) {
          e.preventDefault()
          this.toggleEditingInlineFormat(format)
        } else if (mod && !e.shiftKey && key === 'k') {
          e.preventDefault()
          this.editEditingLink()
        } else if (mod && e.key === 'Enter') {
          e.preventDefault()
          const edited = node
          this.commitEdit()
          const created = this.session.insertChildOf(edited.id)
          if (created) this.startEdit(created.id)
        } else if ((e.key === '.' || e.key === '>') && (mod || e.altKey)) {
          e.preventDefault()
          this.commitEdit()
          if (mod && e.altKey && e.shiftKey) this.session.toggleCollapseAll()
          else if (mod && e.shiftKey) this.session.toggleCollapseSiblings(node.id)
          else this.toggleCollapseWithCompensation(node.id)
          this.container.focus()
        } else if (mod && (key === 'z' || key === 'y')) {
          e.preventDefault()
          this.commitEdit()
          if (key === 'z' && !e.shiftKey) this.session.undo()
          else this.session.redo()
          this.container.focus()
        } else if (mod && key === 'f') {
          e.preventDefault()
          this.events.onRequestSearch?.()
        } else if (mod && e.key === ']') {
          e.preventDefault()
          this.commitEdit()
          this.session.focusNode(node.id)
          this.container.focus()
        } else if (mod && e.key === '[') {
          e.preventDefault()
          this.commitEdit()
          if (this.session.focusPath.length > 0) this.session.exitFocusTo(this.session.focusPath.length - 1)
          this.container.focus()
        } else if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          this.commitEdit()
          this.session.moveSelectedNodes(e.key === 'ArrowUp' ? -1 : 1)
          this.container.focus()
        } else if (mod && e.shiftKey && key === 'backspace') {
          e.preventDefault()
          this.commitEdit()
          this.session.removeSelectedNodes()
          this.container.focus()
        } else if (mod && e.shiftKey && key === 'l') {
          e.preventDefault()
          this.commitEdit()
          this.session.toggleTaskSelectedNodes()
          this.container.focus()
        } else if (mod && e.shiftKey && key === 'k') {
          e.preventDefault()
          this.commitEdit()
          this.session.toggleCheckedSelectedNodes()
          this.container.focus()
        } else if (mod && key === 'd') {
          e.preventDefault()
          this.commitEdit()
          this.session.duplicateSelectedNodes()
          this.container.focus()
        } else if (mod && key === 'a') {
          const fullySelected = input.selectionStart === 0 && input.selectionEnd === input.value.length
          if (fullySelected) {
            e.preventDefault()
            this.commitEdit()
            this.selectAllVisible()
            this.container.focus()
          }
        } else if (!mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          this.commitEdit()
          this.extendVerticalSelection(e.key === 'ArrowUp' ? -1 : 1)
          this.container.focus()
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          this.commitEdit()
          this.container.focus()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          this.cancelEdit()
        } else if (e.key === 'Tab') {
          e.preventDefault()
          const edited = node
          this.commitEdit()
          if (e.shiftKey) {
            const created = this.session.insertParentOf(edited.id)
            if (created) this.startEdit(created.id)
          } else {
            // 脑图编辑态 Tab：新增子主题并继续编辑
            const created = this.session.insertChildOf(edited.id)
            if (created) this.startEdit(created.id)
          }
        }
      }
    })
    input.addEventListener('blur', () => {
      if (!this.suspendEditingBlur) this.commitEdit()
    })
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    addButton.addEventListener('pointerdown', (e) => {
      // 不让按钮抢走 contenteditable 焦点；click 中显式提交并新建。
      e.preventDefault()
      e.stopPropagation()
    })
    addButton.addEventListener('click', (e) => {
      e.stopPropagation()
      const parentId = node.id
      this.commitEdit()
      const created = this.session.insertChildOf(parentId)
      if (created) this.startEdit(created.id)
    })
  }

  private renderEditingDraft(raw: string, start?: number, end = start): void {
    const input = this.editingInput
    const node = this.editingNode
    if (!input || !node) return
    this.editingDraftRaw = raw
    renderCanvasInlineRuns(input, raw, !!node.content.image)
    input.dispatchEvent(new Event('draft-render'))
    if (start !== undefined) {
      input.focus()
      input.setSelectionRange(start, end ?? start)
    }
  }

  private commitEdit(): void {
    if (!this.editingInput || !this.editingNode) return
    const input = this.editingInput
    const node = this.editingNode
    this.editingInput = null
    const addButton = this.editingAddButton
    this.editingAddButton = null
    this.editingNode = null
    const raw = this.editingDraftRaw.trim()
    input.remove()
    addButton?.remove()
    // 幕布：允许空节点常驻；Esc/失焦不自动删除
    this.editingDraftRaw = ''
    this.editingInitialDisplayText = ''
    this.editingComposing = false
    if (raw !== node.content.raw) this.session.updateNodeRaw(node.id, raw)
    else this.relayout()
  }

  /**
   * 把编辑框中的可见文案同步到行内模型，并将 textarea 选区换算到 trim 后的文案。
   * 同步不会结束编辑；后续格式命令因此能够保持光标与选区。
   */
  private syncEditingDisplayText(): {
    input: CanvasRichEditorElement
    node: MindmapNode
    start: number
    end: number
  } | null {
    const input = this.editingInput
    const editingNode = this.editingNode
    if (!input || !editingNode || editingNode.content.image) return null

    const start = input.selectionStart
    const end = input.selectionEnd

    if (editingNode.content.raw !== this.editingDraftRaw) {
      this.session.updateNodeRaw(editingNode.id, this.editingDraftRaw)
    }
    const node = this.session.document.find(editingNode.id)
    if (!node) return null
    this.editingNode = node
    this.editingDraftRaw = node.content.raw
    renderCanvasInlineRuns(input, this.editingDraftRaw)
    input.setSelectionRange(start, end)
    return { input, node, start, end }
  }

  private inlineFormatShortcut(e: KeyboardEvent, hasSelection: boolean): InlineFormat | null {
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    if (mod && !e.shiftKey && key === 'b') return 'bold'
    if (mod && !e.shiftKey && key === 'i') return 'italic'
    if (mod && !e.shiftKey && key === 'u') return 'underline'
    // 幕布主键位：有文本选区时 Cmd/Ctrl+Enter 切换删除线。
    if (mod && key === 'enter' && hasSelection) return 'strike'
    // 兼容常见编辑器键位，便于从旧版本迁移。
    if (mod && e.shiftKey && key === 's') return 'strike'
    if (mod && e.shiftKey && key === 'h') return 'highlight'
    // 行内代码采用常见编辑器键位 Cmd/Ctrl+E；Option/Alt+L 会在 macOS 输入 ¬。
    if (mod && !e.shiftKey && key === 'e') return 'code'
    return null
  }

  private toggleEditingInlineFormat(format: InlineFormat): void {
    const state = this.syncEditingDisplayText()
    if (!state || state.input.value.length === 0) return
    const collapsed = state.start === state.end
    const start = collapsed ? 0 : state.start
    const end = collapsed ? state.input.value.length : state.end
    this.session.toggleNodeInlineFormat(state.node.id, start, end, format)
    const node = this.session.document.find(state.node.id)
    if (!node) return
    this.editingNode = node
    this.renderEditingDraft(node.content.raw, state.start, collapsed ? state.start : state.end)
  }

  private clearEditingInlineFormats(): void {
    const state = this.syncEditingDisplayText()
    if (!state || state.input.value.length === 0) return
    const collapsed = state.start === state.end
    const start = collapsed ? 0 : state.start
    const end = collapsed ? state.input.value.length : state.end
    this.session.clearNodeInlineFormats(state.node.id, start, end)
    const node = this.session.document.find(state.node.id)
    if (!node) return
    this.editingNode = node
    this.renderEditingDraft(node.content.raw, state.start, collapsed ? state.start : state.end)
  }

  private selectedLinkUrl(node: MindmapNode, start: number, end: number): string {
    if (node.content.link && start === 0 && end === node.content.text.length) return node.content.link
    let plainOffset = 0
    const urls = new Set<string>()
    for (const segment of parseInlineSegments(node.content.raw)) {
      const segmentStart = plainOffset
      const segmentEnd = plainOffset + segment.text.length
      if (segmentEnd > start && segmentStart < end && segment.link) urls.add(segment.link.url)
      plainOffset = segmentEnd
    }
    return urls.size === 1 ? [...urls][0] : ''
  }

  /** Cmd/Ctrl+K：脑图编辑态的过渡交互；空地址表示移除链接，取消则不修改。 */
  private editEditingLink(): void {
    const state = this.syncEditingDisplayText()
    if (!state) return
    const start = state.start === state.end ? 0 : state.start
    const end = state.start === state.end ? state.node.content.text.length : state.end
    if (start === end) return
    const current = this.selectedLinkUrl(state.node, start, end)
    let next: string | null
    this.suspendEditingBlur = true
    try {
      next = window.prompt('链接地址（留空可移除链接）', current)
    } finally {
      this.suspendEditingBlur = false
    }
    if (next === null) {
      state.input.focus()
      state.input.setSelectionRange(state.start, state.end)
      return
    }
    this.session.setNodeInlineLink(state.node.id, start, end, next.trim() || null)
    const node = this.session.document.find(state.node.id)
    if (!node) return
    this.editingNode = node
    this.renderEditingDraft(node.content.raw, state.start, state.end)
  }

  private cancelEdit(): void {
    if (!this.editingInput || !this.editingNode) return
    const input = this.editingInput
    this.editingInput = null
    const addButton = this.editingAddButton
    this.editingAddButton = null
    this.editingNode = null
    this.editingDraftRaw = ''
    this.editingInitialDisplayText = ''
    this.editingComposing = false
    input.remove()
    addButton?.remove()
    this.relayout()
    this.container.focus()
  }

  // ---------- 键盘 ----------

  private onKeydown = (e: KeyboardEvent): void => {
    if (this.editingInput) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    const session = this.session

    if (e.code === 'Space' && !mod) {
      e.preventDefault()
      this.spacePressed = true
      this.container.classList.add('is-space-pan')
      return
    }

    const selectionFormat = this.inlineFormatShortcut(e, session.selectionIds.size > 1)
    if (selectionFormat && session.selectionIds.size > 0) {
      e.preventDefault()
      session.formatSelectedNodes(selectionFormat)
      return
    }

    if (mod && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) session.redo()
      else session.undo()
      return
    }
    if (mod && key === 'y') {
      e.preventDefault()
      session.redo()
      return
    }
    if (mod && key === 'f') {
      e.preventDefault()
      this.events.onRequestSearch?.()
      return
    }
    if (mod && key === 'a') {
      e.preventDefault()
      this.selectAllVisible()
      return
    }
    if (mod && key === '\\') {
      e.preventDefault()
      session.clearSelectedNodeFormats()
      return
    }
    if ((e.key === '.' || e.key === '>') && (mod || e.altKey)) {
      e.preventDefault()
      const selected = session.selectedNode
      if (mod && e.altKey && e.shiftKey) session.toggleCollapseAll()
      else if (mod && e.shiftKey && selected) session.toggleCollapseSiblings(selected.id)
      else if (selected) this.toggleCollapseWithCompensation(selected.id)
      return
    }
    // 幕布：Cmd/Ctrl+] 进入当前主题，Cmd/Ctrl+[ 返回父主题。
    if (mod && e.key === ']') {
      e.preventDefault()
      session.focusSelected()
      return
    }
    if (mod && e.key === '[') {
      e.preventDefault()
      if (session.focusPath.length > 0) session.exitFocusTo(session.focusPath.length - 1)
      return
    }
    if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      session.moveSelectedNodes(e.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (mod && e.shiftKey && key === 'backspace') {
      e.preventDefault()
      session.removeSelectedNodes()
      return
    }
    if (mod && e.shiftKey && key === 'l') {
      e.preventDefault()
      session.toggleTaskSelectedNodes()
      return
    }
    if (mod && e.shiftKey && key === 'k') {
      e.preventDefault()
      session.toggleCheckedSelectedNodes()
      return
    }
    if (mod && key === 'd') {
      e.preventDefault()
      session.duplicateSelectedNodes()
      return
    }

    const sel = session.selectedNode
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        if (sel) {
          const created = session.insertSiblingOf(sel.id)
          if (created) this.startEdit(created.id)
        }
        break
      case 'Tab':
        e.preventDefault()
        if (sel) {
          if (e.shiftKey) {
            const created = session.insertParentOf(sel.id)
            if (created) this.startEdit(created.id)
          } else {
            // 脑图式：Tab 新增子主题并进入编辑
            const created = session.insertChildOf(sel.id)
            if (created) this.startEdit(created.id)
          }
        }
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (sel) session.removeSelectedNodes()
        break
      case 'F2':
        e.preventDefault()
        if (sel) this.startEdit(sel.id)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (e.shiftKey) this.extendVerticalSelection(-1)
        else this.navigateVertical(-1)
        break
      case 'ArrowDown':
        e.preventDefault()
        if (e.shiftKey) this.extendVerticalSelection(1)
        else this.navigateVertical(1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (sel) {
          if (sel.parent) session.select(sel.parent.id)
          else if (session.focusPath.length > 0) session.exitFocusTo(session.focusPath.length - 1)
        }
        break
      case 'ArrowRight':
        e.preventDefault()
        if (sel) {
          if (sel.collapsed && sel.children.length > 0) {
            this.toggleCollapseWithCompensation(sel.id)
          } else {
            const first = visibleChildren(sel)[0]
            if (first) session.select(first.id)
          }
        }
        break
    }
  }

  private onKeyup = (e: KeyboardEvent): void => {
    if (e.code !== 'Space') return
    this.spacePressed = false
    this.container.classList.remove('is-space-pan', 'is-panning')
  }

  private navigateVertical(dir: -1 | 1): void {
    const selected = this.session.selectedNode
    if (!selected) {
      const first = this.sortedVerticalBoxes()[0]
      if (first) this.session.select(first.id)
      return
    }

    // 幕布：上下优先在同一父节点的可见兄弟间移动。
    const siblings = selected.parent
      ? visibleChildren(selected.parent).filter((node) => this.layout.boxes.has(node.id))
      : []
    const siblingIndex = siblings.indexOf(selected)
    const sibling = siblingIndex >= 0 ? siblings[siblingIndex + dir] : null
    if (sibling) {
      this.session.select(sibling.id)
      return
    }

    // 边界处退化为几何方向最近节点，横向距离作为次要代价。
    const current = this.layout.boxes.get(selected.id)
    if (!current) return
    const cx = current.x + current.width / 2
    const cy = current.y + current.height / 2
    const candidates = [...this.layout.boxes.values()]
      .filter((box) => box.id !== selected.id)
      .map((box) => {
        const bx = box.x + box.width / 2
        const by = box.y + box.height / 2
        const dy = (by - cy) * dir
        return { box, dy, score: dy + Math.abs(bx - cx) * 0.35 }
      })
      .filter((item) => item.dy > 1)
      .sort((a, b) => a.score - b.score)
    if (candidates[0]) this.session.select(candidates[0].box.id)
  }

  private selectAllVisible(): void {
    const ids = [...this.layout.boxes.keys()].filter((id) => id !== this.session.focusRootNode.id)
    if (ids.length > 0) this.session.selectMany(ids, ids[ids.length - 1], ids[0])
  }

  private extendVerticalSelection(dir: -1 | 1): void {
    const sorted = this.sortedVerticalBoxes()
    if (sorted.length === 0) return
    const selectedId = this.session.selectedNode?.id ?? null
    const current = selectedId ? sorted.findIndex((box) => box.id === selectedId) : -1
    const nextIndex = current < 0 ? (dir > 0 ? 0 : sorted.length - 1) : Math.max(0, Math.min(sorted.length - 1, current + dir))
    this.extendSelectionTo(sorted[nextIndex].id)
  }

  private extendSelectionTo(id: string): void {
    const sorted = this.sortedVerticalBoxes()
    const targetIndex = sorted.findIndex((box) => box.id === id)
    if (targetIndex < 0) return
    const anchorId = this.session.selectionAnchor?.id ?? this.session.selectedNode?.id ?? id
    const anchorIndex = sorted.findIndex((box) => box.id === anchorId)
    const normalizedAnchor = anchorIndex >= 0 ? anchorIndex : targetIndex
    const from = Math.min(normalizedAnchor, targetIndex)
    const to = Math.max(normalizedAnchor, targetIndex)
    this.session.selectMany(
      sorted.slice(from, to + 1).map((box) => box.id),
      id,
      sorted[normalizedAnchor].id,
    )
  }

  private sortedVerticalBoxes() {
    return [...this.layout.boxes.values()].sort((a, b) => {
      const dy = a.y + a.height / 2 - (b.y + b.height / 2)
      return dy !== 0 ? dy : a.x - b.x
    })
  }

  // ---------- 指针交互 ----------

  private eventWorld(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect()
    return {
      x: (ev.clientX - rect.left - this.transform.x) / this.transform.k,
      y: (ev.clientY - rect.top - this.transform.y) / this.transform.k,
    }
  }

  private hit(ev: PointerEvent | MouseEvent) {
    const world = this.eventWorld(ev)
    return hitTest(this.layout.boxes.values(), world.x, world.y, {
      selectedId: this.session.selectedNode?.id ?? null,
      selectionCount: this.session.selectionIds.size,
      imageAspects: this.imageAspects,
      hoveredId: this.hoveredNodeId,
    })
  }

  private updateHover(ev: PointerEvent): void {
    const world = this.eventWorld(ev)
    const hit = this.hit(ev)
    const hoveredId = hit?.id ?? null
    if (hoveredId !== this.hoveredNodeId) {
      this.hoveredNodeId = hoveredId
      this.renderer.setHoveredNode(hoveredId)
    }

    const linkHit = this.renderer.hitInlineLink(world.x, world.y)
    this.container.classList.toggle('is-link-hover', !!linkHit)
    this.container.classList.toggle('is-control-hover', hit?.role === 'add' || hit?.role === 'collapse' || hit?.role === 'checkbox')
    const nextKey = linkHit ? `${linkHit.id}:${linkHit.rawStart}:${linkHit.rawEnd}` : null
    if (nextKey === this.pendingLinkKey) return
    this.pendingLinkKey = nextKey
    if (this.linkHoverTimer) clearTimeout(this.linkHoverTimer)
    this.linkHoverTimer = null
    if (!linkHit) {
      this.events.onLinkHover?.(null)
      return
    }
    this.linkHoverTimer = setTimeout(() => {
      if (this.pendingLinkKey !== nextKey) return
      const rect = this.container.getBoundingClientRect()
      const centerX = rect.left + this.transform.x + (linkHit.rect.x + linkHit.rect.width / 2) * this.transform.k
      const bottomY = rect.top + this.transform.y + (linkHit.rect.y + linkHit.rect.height) * this.transform.k
      this.events.onLinkHover?.({
        nodeId: linkHit.id,
        url: linkHit.url,
        rawStart: linkHit.rawStart,
        rawEnd: linkHit.rawEnd,
        position: {
          left: Math.max(220, Math.min(window.innerWidth - 220, centerX)),
          top: Math.min(window.innerHeight - 54, bottomY + 6),
        },
      })
    }, 380)
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || this.editingInput) return
    this.events.onContextMenu?.(null)
    const hit = this.hit(ev)
    if (this.spacePressed) {
      ev.preventDefault()
      this.commitEdit()
      this.container.focus()
      this.panState = { startX: ev.clientX, startY: ev.clientY, baseX: this.transform.x, baseY: this.transform.y }
      this.panMoved = false
      this.container.classList.add('is-panning')
      return
    }
    if (!hit) {
      // 幕布口径：空白拖动框选；按住 Space 才平移画布。
      ev.preventDefault()
      this.commitEdit()
      this.container.focus()
      this.startSelectionBox(ev.clientX, ev.clientY)
      return
    }
    if (hit.role === 'resize') {
      // 图片调宽：拖动前暂存快照，松手时再入历史
      this.resizeState = { id: hit.id, snapshot: snapshotDoc(this.session.document), moved: false }
      return
    }
    if (hit.role === 'add' || hit.role === 'collapse' || hit.role === 'checkbox') return
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault()
      this.container.focus()
      return
    }
    if (ev.shiftKey) {
      ev.preventDefault()
      this.extendSelectionTo(hit.id)
      this.container.focus()
      return
    }
    const world = this.eventWorld(ev)
    const box = this.layout.boxes.get(hit.id)
    this.dragState = {
      id: hit.id,
      startX: ev.clientX,
      startY: ev.clientY,
      offsetX: box ? world.x - box.x : 0,
      offsetY: box ? world.y - box.y : 0,
      dragging: false,
    }
  }

  private onClick = (ev: MouseEvent): void => {
    if (this.suppressClick) return
    if (this.editingInput && ev.target instanceof Node && this.editingInput.contains(ev.target)) return
    const world = this.eventWorld(ev)
    const inlineLink = this.renderer.hitInlineLink(world.x, world.y)
    if (inlineLink) {
      const url = this.navigableUrl(inlineLink.url)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
      ev.preventDefault()
      return
    }
    const hit = this.hit(ev)
    if (!hit) return
    const session = this.session
    const node = session.document.find(hit.id)
    if (!node) return
    switch (hit.role) {
      case 'add': {
        // 编辑态点击右侧「+」时先提交当前主题，再新建并立即编辑子主题。
        const parentId = hit.id
        this.commitEdit()
        const created = session.insertChildOf(parentId)
        if (created) this.startEdit(created.id)
        return
      }
      case 'checkbox':
        session.toggleChecked(hit.id)
        return
      case 'collapse':
        this.toggleCollapseWithCompensation(hit.id)
        return
      case 'link':
        if (node.content.link) {
          const url = this.navigableUrl(node.content.link)
          if (url) window.open(url, '_blank', 'noopener,noreferrer')
        }
        return
      case 'image':
        if (node.content.image) this.events.onImagePreview?.(this.events.resolveImageSrc?.(node.content.image.src) ?? node.content.image.src)
        return
      default:
        if (ev.metaKey || ev.ctrlKey) this.toggleDiscreteSelection(hit.id)
        else if (ev.shiftKey) this.extendSelectionTo(hit.id)
        else session.select(hit.id)
        this.container.focus()
        ev.preventDefault()
    }
  }

  private navigableUrl(raw: string): string | null {
    const url = raw.trim()
    if (!url || /^(?:javascript|data|vbscript):/i.test(url)) return null
    if (/^(?:https?|mailto|tel):/i.test(url) || /^(?:[./#]|\/)/.test(url)) return url
    return `https://${url}`
  }

  private onDblClick = (ev: MouseEvent): void => {
    if (this.suppressClick) return
    const hit = this.hit(ev)
    if (hit && hit.role !== 'add' && hit.role !== 'collapse') this.startEdit(hit.id)
  }

  private onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault()
    // 编辑层位于 Canvas 之上，右键时先提交，使布局和命中区域保持同一份数据。
    this.commitEdit()
    const hit = this.hit(ev)
    if (!hit) {
      this.events.onContextMenu?.(null)
      return
    }
    const node = this.session.document.find(hit.id)
    if (!node) {
      this.events.onContextMenu?.(null)
      return
    }

    // 右键已选节点保留离散多选；右键未选节点则改为该节点单选。
    if (!this.session.selectionIds.has(node.id)) this.session.select(node.id)
    const protectedRoot = node === this.session.document.root || node === this.session.focusRootNode
    const selectionHasProtectedRoot = this.session.selectedNodes.some((item) =>
      item === this.session.document.root || item === this.session.focusRootNode)
    this.events.onLinkHover?.(null)
    this.events.onContextMenu?.({
      nodeId: node.id,
      position: { left: ev.clientX, top: ev.clientY },
      multiple: this.session.selectionIds.size > 1,
      canInsertSibling: !protectedRoot && !!node.parent,
      canInsertParent: !protectedRoot && !!node.parent,
      canCut: !selectionHasProtectedRoot,
      canDuplicate: !selectionHasProtectedRoot,
      canDeleteOnly: !protectedRoot && !!node.parent,
      canDeleteTree: !selectionHasProtectedRoot,
      canToggleSiblings: !protectedRoot && !!node.parent,
      canFocus: node !== this.session.focusRootNode,
    })
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.resizeState) {
      const node = this.session.document.find(this.resizeState.id)
      const box = node ? this.layout.boxes.get(node.id) : null
      if (node?.content.image && box) {
        const world = this.eventWorld(ev)
        const imgW = node.content.image.width ?? 120
        const imgLeft = box.x + (box.width - imgW) / 2
        const newWidth = Math.min(Math.max(Math.round(world.x - imgLeft), 40), 800)
        if (newWidth !== node.content.image.width) {
          this.session.document.setImageWidth(node, newWidth)
          this.resizeState.moved = true
          this.relayout()
        }
      }
      this.suppressClick = true
      return
    }

    if (this.panState) {
      this.panMoved = true
      this.setTransform({
        ...this.transform,
        x: this.panState.baseX + (ev.clientX - this.panState.startX),
        y: this.panState.baseY + (ev.clientY - this.panState.startY),
      })
      this.suppressClick = true
      return
    }

    if (this.selectionBoxState) {
      const state = this.selectionBoxState
      state.currentX = ev.clientX
      state.currentY = ev.clientY
      state.moved = state.moved || Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) >= 4
      this.updateSelectionBox()
      if (state.moved) this.selectNodesInMarquee()
      this.suppressClick = state.moved
      return
    }

    // 链接浮层 Teleport 到 body；指针进入浮层时不能按“离开 Canvas 链接”关闭它。
    if (ev.target instanceof Element && ev.target.closest('.link-popover')) return
    this.updateHover(ev)

    const drag = this.dragState
    if (!drag) return
    if (!drag.dragging) {
      const dist = Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY)
      if (dist < 5) return
      drag.dragging = true
      this.session.select(drag.id)
      this.container.classList.add('is-node-dragging')
    }
    this.suppressClick = true
    const world = this.eventWorld(ev)
    const indicator = this.computeDrop(drag.id, world.x, world.y)
    const preview: CanvasDragPreview = {
      sourceId: drag.id,
      pointer: world,
      offset: { x: drag.offsetX, y: drag.offsetY },
      indicator,
    }
    this.renderer.setDragPreview(preview)
  }

  private onPointerUp = (): void => {
    if (this.resizeState) {
      const rs = this.resizeState
      this.resizeState = null
      if (rs.moved) {
        // 拖动中直接改了文档（未入历史），松手时把拖动前快照补记进历史
        this.session.recordSnapshot(rs.snapshot)
      }
      setTimeout(() => (this.suppressClick = false), 0)
      return
    }

    if (this.panState) {
      // 无位移的空白点击 = 取消选中
      if (!this.panMoved) this.session.select(null)
      this.panState = null
      this.panMoved = false
      this.container.classList.remove('is-panning')
      setTimeout(() => (this.suppressClick = false), 0)
      return
    }
    if (this.selectionBoxState) {
      const moved = this.selectionBoxState.moved
      if (!moved) this.session.select(null)
      else this.selectNodesInMarquee()
      this.selectionBoxState = null
      this.selectionBoxEl?.remove()
      this.selectionBoxEl = null
      setTimeout(() => (this.suppressClick = false), 0)
      return
    }
    const drag = this.dragState
    this.dragState = null
    if (!drag?.dragging) return
    this.container.classList.remove('is-node-dragging')
    const indicator = this.currentIndicator
    this.renderer.setDragPreview(null)
    this.currentIndicator = null
    setTimeout(() => (this.suppressClick = false), 0)
    if (!indicator) return

    const session = this.session
    const node = session.document.find(drag.id)
    const target = session.document.find(indicator.targetId)
    if (!node || !target) return
    if (indicator.type === 'child') {
      session.moveNode(drag.id, target.id, target.children.length)
    } else if (target.parent) {
      const idx = target.parent.children.indexOf(target)
      session.moveNode(drag.id, target.parent.id, indicator.type === 'before' ? idx : idx + 1)
    }
    session.select(drag.id)
  }

  private startSelectionBox(clientX: number, clientY: number): void {
    this.selectionBoxState = { startX: clientX, startY: clientY, currentX: clientX, currentY: clientY, moved: false }
    const box = document.createElement('div')
    box.className = 'mm-selection-box'
    this.overlay.append(box)
    this.selectionBoxEl = box
    this.updateSelectionBox()
  }

  private updateSelectionBox(): void {
    const state = this.selectionBoxState
    const box = this.selectionBoxEl
    if (!state || !box) return
    const rect = this.container.getBoundingClientRect()
    const left = Math.min(state.startX, state.currentX) - rect.left
    const top = Math.min(state.startY, state.currentY) - rect.top
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.width = `${Math.abs(state.currentX - state.startX)}px`
    box.style.height = `${Math.abs(state.currentY - state.startY)}px`
  }

  private selectNodesInMarquee(): void {
    const state = this.selectionBoxState
    if (!state) return
    const rect = this.container.getBoundingClientRect()
    const toWorld = (clientX: number, clientY: number) => ({
      x: (clientX - rect.left - this.transform.x) / this.transform.k,
      y: (clientY - rect.top - this.transform.y) / this.transform.k,
    })
    const a = toWorld(state.startX, state.startY)
    const b = toWorld(state.currentX, state.currentY)
    const left = Math.min(a.x, b.x)
    const right = Math.max(a.x, b.x)
    const top = Math.min(a.y, b.y)
    const bottom = Math.max(a.y, b.y)
    const ids = [...this.layout.boxes.values()]
      .filter((box) => box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top)
      .map((box) => box.id)
    this.session.selectMany(ids, ids[ids.length - 1] ?? null, ids[0] ?? null)
  }

  private toggleDiscreteSelection(id: string): void {
    const ids = new Set(this.session.selectionIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    const primary = ids.has(id) ? id : [...ids][ids.size - 1] ?? null
    this.session.selectMany(ids, primary, this.session.selectionAnchor?.id ?? primary)
  }

  private computeDrop(dragId: string, wx: number, wy: number): DropIndicator | null {
    const doc = this.session.document
    const dragNode = doc.find(dragId)
    if (!dragNode) return null
    let best: DropIndicator | null = null
    let corridorBest: { indicator: DropIndicator; score: number } | null = null
    for (const box of this.layout.boxes.values()) {
      if (box.id === dragId) continue
      const target = box.node
      if (isAncestor(dragNode, target) || target === dragNode) continue

      const insideExpanded = wx >= box.x - 10 && wx <= box.x + box.width + 10 &&
        wy >= box.y - 10 && wy <= box.y + box.height + 10
      if (insideExpanded) {
        const ratio = (wy - box.y) / box.height
        const type: DropIndicator['type'] = box.depth === 0
          ? 'child'
          : ratio < 0.3
            ? 'before'
            : ratio > 0.7
              ? 'after'
              : 'child'
        best = { type, targetId: box.id }
        break
      }

      // 幕布允许把主题拖到候选父主题右侧的空白处。用一条有限的水平走廊持续提供
      // “成为子主题”的预览，而不要求指针必须压在父主题矩形上。
      const horizontalGap = wx - (box.x + box.width)
      const verticalGap = Math.abs(wy - (box.y + box.height / 2))
      if (horizontalGap < 0 || horizontalGap > 360 || verticalGap > Math.max(42, box.height * 1.5)) continue
      const score = horizontalGap * 0.22 + verticalGap
      if (!corridorBest || score < corridorBest.score) {
        corridorBest = { indicator: { type: 'child', targetId: box.id }, score }
      }
    }
    best ??= corridorBest?.indicator ?? null
    this.currentIndicator = best
    return best
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const rect = this.container.getBoundingClientRect()
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015))
    } else {
      this.setTransform({
        ...this.transform,
        x: this.transform.x - e.deltaX,
        y: this.transform.y - e.deltaY,
      })
    }
  }

  private onPaste = (e: ClipboardEvent): void => {
    const image = [...(e.clipboardData?.items ?? [])]
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
      ?.getAsFile()
    if (!image) return
    const anchorId = this.editingNode?.id ?? this.session.selectedNode?.id ?? this.session.focusRootNode.id
    e.preventDefault()
    this.commitEdit()
    this.events.onPasteImage?.(anchorId, image)
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const k = Math.min(Math.max(this.transform.k * factor, MIN_SCALE), MAX_SCALE)
    const real = k / this.transform.k
    this.setTransform({
      x: px - (px - this.transform.x) * real,
      y: py - (py - this.transform.y) * real,
      k,
    })
  }

  destroy(): void {
    this.commitEdit()
    const session = this.session
    session.off('change', this.onSessionChange)
    session.off('collapseChange', this.onSessionViewChange)
    session.off('focusChange', this.onSessionFocusChange)
    session.off('selectionChange', this.onSessionSelectionChange)
    session.off('matchChange', this.onSessionViewChange)
    this.container.removeEventListener('pointerdown', this.onPointerDown)
    this.container.removeEventListener('click', this.onClick)
    this.container.removeEventListener('dblclick', this.onDblClick)
    this.container.removeEventListener('contextmenu', this.onContextMenu)
    this.container.removeEventListener('keydown', this.onKeydown)
    this.container.removeEventListener('keyup', this.onKeyup)
    this.container.removeEventListener('paste', this.onPaste)
    this.container.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('resize', this.onViewportResize)
    this.renderer.destroy()
    if (this.linkHoverTimer) clearTimeout(this.linkHoverTimer)
    this.events.onContextMenu?.(null)
    this.container.classList.remove('is-space-pan', 'is-panning', 'is-node-dragging', 'is-link-hover', 'is-control-hover')
    this.selectionBoxEl?.remove()
    this.overlay.remove()
  }
}
