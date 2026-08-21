/**
 * Canvas 渲染器：每帧全量重绘视口内元素（无 DOM 开销，支撑万级节点）。
 * 绘制：贝塞尔连线、圆角节点、文本、checkbox、图片（位图缓存）、折叠圆点、
 * 选中框、搜索高亮、拖拽指示、图片 resize 手柄。
 * 几何与命中检测共用 hitTest.ts 的 nodeGeometry，保证画点一致。
 */

import type { LayoutResult, NodeBox } from '../layout/treeLayout'
import { TEXT_LINE_HEIGHT } from '../layout/treeLayout'
import type { MindmapNode } from '../model/document'
import { parseInlineSegments } from '../model/inline'
import type { InlineMarks } from '../model/inline'
import { nodeGeometry, resolveNodeControl } from './hitTest'

export interface ViewTransform {
  x: number
  y: number
  k: number
}

export interface DropIndicator {
  type: 'child' | 'before' | 'after'
  targetId: string
}

/**
 * 节点拖动期间的纯视觉状态。树结构仍保持不变，直到 pointerup 才真正提交移动。
 * pointer/offset 使用世界坐标，使缩放和平移不影响拖动预览的几何关系。
 */
export interface CanvasDragPreview {
  sourceId: string
  pointer: { x: number; y: number }
  offset: { x: number; y: number }
  indicator: DropIndicator | null
}

export interface CanvasRenderState {
  root: MindmapNode
  selection: Set<string>
  matches: Set<string>
  imageAspects: ReadonlyMap<string, number>
}

export type CanvasNodeTier = 'root' | 'primary' | 'secondary' | 'tertiary'

export interface CanvasWorldRect {
  x: number
  y: number
  width: number
  height: number
}

/** Canvas 内精确到一段链接文字的世界坐标命中信息。 */
export interface CanvasInlineLinkHit {
  id: string
  url: string
  rawStart: number
  rawEnd: number
  rect: CanvasWorldRect
}

/** 根、一级、二级、三级及以后分别使用明确而稳定的视觉层级。 */
export function canvasNodeTier(depth: number): CanvasNodeTier {
  if (depth <= 0) return 'root'
  if (depth === 1) return 'primary'
  if (depth === 2) return 'secondary'
  return 'tertiary'
}

/** 折叠计数包含全部后代，而不只是直接子节点。 */
export function descendantCount(node: MindmapNode): number {
  let count = 0
  const pending = [...node.children]
  while (pending.length > 0) {
    const child = pending.pop()!
    count += 1
    pending.push(...child.children)
  }
  return count
}

export function shouldShowCollapseControl(node: MindmapNode, hoveredId: string | null): boolean {
  const control = resolveNodeControl(node, false, hoveredId)
  return control === 'collapse' || control === 'count'
}

interface CanvasTheme {
  canvasBg: string
  nodeBg: string
  nodeBorder: string
  text: string
  rootBg: string
  rootText: string
  primaryBg: string
  primaryBorder: string
  primaryText: string
  link: string
  accent: string
  selectionBg: string
  matchBg: string
  dim: string
}

/**
 * `auto` keeps the standalone editor backward compatible by following the OS.
 * Embedders such as VitePress should pass an explicit light/dark value instead.
 */
export type CanvasThemeMode = 'auto' | 'light' | 'dark'

const LIGHT: CanvasTheme = {
  canvasBg: '#f7f8fa',
  nodeBg: '#ffffff',
  nodeBorder: '#c9d0da',
  text: '#2b3139',
  rootBg: '#2b3139',
  rootText: '#ffffff',
  primaryBg: '#e7eaf0',
  primaryBorder: '#d0d5de',
  primaryText: '#2b3139',
  link: '#b6bcc7',
  accent: '#4f8ef7',
  selectionBg: 'rgba(79, 142, 247, 0.10)',
  matchBg: 'rgba(255, 213, 79, 0.35)',
  dim: '#8a919e',
}

const DARK: CanvasTheme = {
  canvasBg: '#1e2126',
  nodeBg: '#2e323a',
  nodeBorder: '#4a4f58',
  text: '#dde1e7',
  rootBg: '#dedede',
  rootText: '#1d1d1f',
  primaryBg: '#3b3b3d',
  primaryBorder: '#49494c',
  primaryText: '#f0f0f2',
  link: '#3a3e46',
  accent: '#6b9eff',
  selectionBg: 'rgba(107, 158, 255, 0.12)',
  matchBg: 'rgba(255, 213, 79, 0.3)',
  dim: '#7a828f',
}

const CULL_MARGIN = 240
const FONT_SIZE = 14
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
const MONO_FONT_FAMILY = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private layout: LayoutResult | null = null
  private state: CanvasRenderState | null = null
  private transform: ViewTransform = { x: 0, y: 0, k: 1 }
  private indicator: DropIndicator | null = null
  private dragPreview: CanvasDragPreview | null = null
  private hoveredId: string | null = null
  private inlineLinkHits: CanvasInlineLinkHit[] = []
  private images = new Map<string, HTMLImageElement>()
  private failedImages = new Set<string>()
  private drawScheduled = false
  private theme: CanvasTheme
  private themeMode: CanvasThemeMode
  private resizeObserver: ResizeObserver
  private darkMedia: MediaQueryList | null
  private onDarkChange = () => {
    if (this.themeMode !== 'auto') return
    this.theme = this.darkMedia?.matches ? DARK : LIGHT
    this.scheduleDraw()
  }

  /** 图片加载完成（成功或失败）时回调，编辑器据此更新宽高比并重排 */
  onImageLoad: ((src: string, aspect: number) => void) | null = null

  constructor(
    private container: HTMLElement,
    private readonly resolveImageSrc: (src: string) => string = (src) => src,
    theme: CanvasThemeMode = 'auto',
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'mm-canvas'
    this.ctx = this.canvas.getContext('2d')!
    container.append(this.canvas)

    this.darkMedia = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
    this.themeMode = theme
    this.theme = this.resolveTheme(theme)
    if (theme === 'auto') this.darkMedia?.addEventListener('change', this.onDarkChange)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  private resolveTheme(theme: CanvasThemeMode): CanvasTheme {
    if (theme === 'dark') return DARK
    if (theme === 'light') return LIGHT
    return this.darkMedia?.matches ? DARK : LIGHT
  }

  /** Switch palette without rebuilding layout, session, or canvas state. */
  setTheme(theme: CanvasThemeMode): void {
    if (theme === this.themeMode) return
    if (this.themeMode === 'auto') this.darkMedia?.removeEventListener('change', this.onDarkChange)
    this.themeMode = theme
    if (theme === 'auto') this.darkMedia?.addEventListener('change', this.onDarkChange)
    this.theme = this.resolveTheme(theme)
    this.scheduleDraw()
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    const cw = this.container.clientWidth
    const ch = this.container.clientHeight
    this.canvas.width = Math.max(1, Math.round(cw * dpr))
    this.canvas.height = Math.max(1, Math.round(ch * dpr))
    this.scheduleDraw()
  }

  setLayout(layout: LayoutResult, state: CanvasRenderState): void {
    this.layout = layout
    this.state = state
    this.inlineLinkHits = []
    this.preloadImages()
    this.scheduleDraw()
  }

  setTransform(t: ViewTransform): void {
    this.transform = t
    this.scheduleDraw()
  }

  setDropIndicator(indicator: DropIndicator | null): void {
    this.indicator = indicator
    this.scheduleDraw()
  }

  /** 同步完整拖动预览：原位占位、浮动副本和候选落点连线共用一次重绘。 */
  setDragPreview(preview: CanvasDragPreview | null): void {
    this.dragPreview = preview
    this.indicator = preview?.indicator ?? null
    this.scheduleDraw()
  }

  /** CanvasEditor 在 pointermove 时同步当前 hover 节点。 */
  setHoveredNode(id: string | null): void {
    if (this.hoveredId === id) return
    this.hoveredId = id
    this.scheduleDraw()
  }

  /**
   * 精确命中一段链接文字。传入布局世界坐标，而非屏幕坐标；
   * CanvasEditor 可将 eventWorld 的结果直接传入。
   */
  hitInlineLink(x: number, y: number): CanvasInlineLinkHit | null {
    for (let i = this.inlineLinkHits.length - 1; i >= 0; i--) {
      const hit = this.inlineLinkHits[i]
      const rect = hit.rect
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return hit
    }
    return null
  }

  private preloadImages(): void {
    if (!this.layout) return
    for (const box of this.layout.boxes.values()) {
      const src = box.node.content.image?.src
      if (!src || this.images.has(src) || this.failedImages.has(src)) continue
      this.failedImages.add(src) // 占位防重复加载；成功后移入 images
      const img = new Image()
      img.onload = () => {
        this.images.set(src, img)
        this.failedImages.delete(src)
        const aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0
        this.onImageLoad?.(src, aspect)
      }
      img.onerror = () => {
        this.onImageLoad?.(src, 0)
      }
      img.src = this.resolveImageSrc(src)
    }
  }

  scheduleDraw(): void {
    if (this.drawScheduled) return
    this.drawScheduled = true
    const run = () => {
      if (!this.drawScheduled) return
      this.drawScheduled = false
      this.draw()
    }
    requestAnimationFrame(run)
    // 后台标签页 rAF 暂停，setTimeout 兜底
    setTimeout(run, 50)
  }

  private visibleWorldRect(): { x: number; y: number; w: number; h: number } {
    const cw = this.container.clientWidth || 800
    const ch = this.container.clientHeight || 600
    const { x, y, k } = this.transform
    return {
      x: -x / k - CULL_MARGIN,
      y: -y / k - CULL_MARGIN,
      w: cw / k + CULL_MARGIN * 2,
      h: ch / k + CULL_MARGIN * 2,
    }
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1
    const cw = this.container.clientWidth
    const ch = this.container.clientHeight
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.ctx.clearRect(0, 0, cw, ch)
    this.inlineLinkHits = []
    if (!this.layout || !this.state) return

    const { x, y, k } = this.transform
    this.ctx.translate(x, y)
    this.ctx.scale(k, k)

    const rect = this.visibleWorldRect()
    const hit = (b: NodeBox) =>
      b.x < rect.x + rect.w && b.x + b.width > rect.x && b.y < rect.y + rect.h && b.y + b.height > rect.y

    const draggedIds = this.draggedSubtreeIds()

    // 连线；拖动中的原子树保留在原位，但降低强调度作为稳定占位。
    this.ctx.lineWidth = 1.5
    this.ctx.strokeStyle = this.theme.link
    for (const link of this.layout.links) {
      const from = this.layout.boxes.get(link.from)!
      const to = this.layout.boxes.get(link.to)!
      if (!hit(from) && !hit(to)) continue
      const x1 = from.x + from.width
      const y1 = from.y + from.height / 2
      const x2 = to.x
      const y2 = to.y + to.height / 2
      const dx = Math.max(24, (x2 - x1) / 2)
      this.ctx.save()
      if (draggedIds.has(link.from) || draggedIds.has(link.to)) this.ctx.globalAlpha = 0.24
      this.ctx.beginPath()
      this.ctx.moveTo(x1, y1)
      this.ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
      this.ctx.stroke()
      this.ctx.restore()
    }

    // 节点；源子树不从布局中移除，避免拖动时其它节点抢占它原来的位置。
    for (const box of this.layout.boxes.values()) {
      if (!hit(box)) continue
      this.ctx.save()
      if (draggedIds.has(box.id)) this.ctx.globalAlpha = 0.24
      this.drawNode(box)
      this.ctx.restore()
    }

    if (this.dragPreview) this.drawDragPreview(this.dragPreview, draggedIds)
    else if (this.indicator) {
      // 兼容只设置落点指示的调用方。
      const target = this.layout.boxes.get(this.indicator.targetId)
      if (target) this.drawDropIndicator(target)
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private drawNode(
    box: NodeBox,
    options: {
      offsetX?: number
      offsetY?: number
      selected?: boolean
      controls?: boolean
      recordLinkHits?: boolean
    } = {},
  ): void {
    const ctx = this.ctx
    const theme = this.theme
    const state = this.state!
    const node = box.node
    const tier = canvasNodeTier(box.depth)
    const isRoot = tier === 'root'
    const isPrimary = tier === 'primary'
    const isFramed = isRoot || isPrimary || node.content.image !== null
    const radius = isRoot ? 9 : isPrimary ? 6 : 5
    const selected = options.selected ?? state.selection.has(node.id)
    const offsetX = options.offsetX ?? 0
    const offsetY = options.offsetY ?? 0
    const geo = nodeGeometry(box, state.imageAspects, selected)

    ctx.save()
    ctx.translate(box.x + offsetX, box.y + offsetY)

    // 搜索高亮底
    if (state.matches.has(node.id)) {
      ctx.fillStyle = theme.matchBg
      ctx.beginPath()
      ctx.roundRect(-3, -3, box.width + 6, box.height + 6, 8)
      ctx.fill()
    }

    // 根节点强强调、一级节点填充、二级及以后保持轻量文字节点。
    if (isFramed) {
      ctx.beginPath()
      ctx.roundRect(0, 0, box.width, box.height, radius)
      ctx.fillStyle = isRoot ? theme.rootBg : isPrimary ? theme.primaryBg : theme.nodeBg
      ctx.fill()
      if (!isRoot) {
        ctx.strokeStyle = isPrimary ? theme.primaryBorder : theme.nodeBorder
        ctx.lineWidth = 1.25
        ctx.stroke()
      }
    } else if (selected) {
      ctx.beginPath()
      ctx.roundRect(0, 0, box.width, box.height, radius)
      ctx.fillStyle = theme.selectionBg
      ctx.fill()
    }

    // 选中框（线宽按缩放补偿，保持屏幕上恒定）
    if (selected) {
      ctx.beginPath()
      ctx.roundRect(0, 0, box.width, box.height, radius)
      ctx.strokeStyle = theme.accent
      ctx.lineWidth = 2.5 / this.transform.k
      ctx.stroke()
    }

    // 任务 checkbox
    if (geo.checkboxRect) {
      const cb = geo.checkboxRect
      ctx.beginPath()
      ctx.roundRect(cb.x, cb.y, cb.w, cb.h, 3)
      if (node.content.checked) {
        ctx.fillStyle = theme.accent
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(cb.x + 2.5, cb.y + cb.h / 2)
        ctx.lineTo(cb.x + 5.5, cb.y + cb.h - 3.5)
        ctx.lineTo(cb.x + cb.w - 2.5, cb.y + 2.5)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()
      } else {
        ctx.strokeStyle = theme.dim
        ctx.lineWidth = 1.2
        ctx.stroke()
      }
    }

    // 文本（按 raw 行内片段绘制，布局仍以纯文案折行）
    const lines = box.textLines.length > 0 ? box.textLines : [node.content.text || ' ']
    const segments = node.content.image
      ? [{
          text: node.content.text,
          marks: { bold: false, italic: false, underline: false, strike: false, highlight: false, code: false },
          link: null,
        }]
      : parseInlineSegments(node.content.raw)
    let segmentOffset = 0
    const positioned = segments.map((segment) => {
      const start = segmentOffset
      segmentOffset += segment.text.length
      return { ...segment, plainStart: start, plainEnd: segmentOffset }
    })
    let lineStart = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineEnd = lineStart + line.length
      let x = geo.textX
      const y = geo.textY + i * TEXT_LINE_HEIGHT
      for (const segment of positioned) {
        const from = Math.max(lineStart, segment.plainStart)
        const to = Math.min(lineEnd, segment.plainEnd)
        if (to <= from) continue
        const text = segment.text.slice(from - segment.plainStart, to - segment.plainStart)
        const width = this.drawInlineRun(
          text,
          x,
          y,
          segment.marks,
          !!segment.link,
          tier,
          node.content.checked === true,
        )
        if (segment.link && options.recordLinkHits !== false) {
          const fontSize = this.inlineFontSize(tier, segment.marks)
          this.inlineLinkHits.push({
            id: node.id,
            url: segment.link.url,
            rawStart: segment.link.rawStart,
            rawEnd: segment.link.rawEnd,
            rect: {
              x: box.x + offsetX + x - 2,
              y: box.y + offsetY + y - fontSize / 2 - 4,
              width: width + 4,
              height: fontSize + 8,
            },
          })
        }
        x += width
      }
      lineStart = lineEnd
    }

    // 图片
    if (geo.imageRect && node.content.image) {
      const ir = geo.imageRect
      const img = this.images.get(node.content.image.src)
      if (img) {
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(ir.x, ir.y, ir.w, ir.h, 4)
        ctx.clip()
        ctx.drawImage(img, ir.x, ir.y, ir.w, ir.h)
        ctx.restore()
      } else {
        // 占位（加载中或失败）
        ctx.beginPath()
        ctx.roundRect(ir.x, ir.y, ir.w, ir.h, 4)
        ctx.fillStyle = theme.matchBg
        ctx.fill()
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = theme.nodeBorder
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.setLineDash([])
      }
      // resize 手柄
      if (geo.resizeHandle) {
        ctx.beginPath()
        ctx.arc(geo.resizeHandle.cx - box.x, geo.resizeHandle.cy - box.y, geo.resizeHandle.r, 0, Math.PI * 2)
        ctx.fillStyle = theme.nodeBg
        ctx.fill()
        ctx.strokeStyle = theme.accent
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    const nodeControl = options.controls === false
      ? null
      : resolveNodeControl(node, state.selection.size === 1 && state.selection.has(node.id), this.hoveredId)
    // 右侧动作圆环：单选/编辑显示「+」；普通 hover 父主题显示「<」；折叠主题显示后代数量。
    if (geo.controlDot && nodeControl) {
      const { r } = geo.controlDot
      const cx = box.width
      const cy = box.height / 2
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = nodeControl === 'add' ? theme.text : theme.canvasBg
      ctx.fill()
      ctx.strokeStyle = nodeControl === 'add' ? theme.text : nodeControl === 'count' ? theme.text : theme.dim
      ctx.lineWidth = 1.5
      ctx.stroke()
      if (nodeControl === 'count') {
        const count = String(descendantCount(node))
        const size = count.length >= 3 ? 8 : count.length === 2 ? 9 : 10
        ctx.font = `600 ${size}px ${FONT_FAMILY}`
        ctx.fillStyle = theme.text
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(count, cx, cy + 0.5)
      } else if (nodeControl === 'collapse') {
        // 使用路径绘制而不是字体字符，避免不同系统字体导致图标漂移。
        ctx.beginPath()
        ctx.moveTo(cx + 2.5, cy - 4)
        ctx.lineTo(cx - 2.5, cy)
        ctx.lineTo(cx + 2.5, cy + 4)
        ctx.strokeStyle = theme.dim
        ctx.lineWidth = 1.7
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()
      } else {
        // 新增图标使用实心圆与反色「+」，选中态在任何 hover 状态下都保持可见。
        ctx.beginPath()
        ctx.moveTo(cx - 4, cy)
        ctx.lineTo(cx + 4, cy)
        ctx.moveTo(cx, cy - 4)
        ctx.lineTo(cx, cy + 4)
        ctx.strokeStyle = theme.canvasBg
        ctx.lineWidth = 1.8
        ctx.lineCap = 'round'
        ctx.stroke()
      }
    }

    ctx.restore()
  }

  private drawInlineRun(
    text: string,
    x: number,
    y: number,
    marks: InlineMarks,
    isLink: boolean,
    tier: CanvasNodeTier,
    isDone: boolean,
  ): number {
    const ctx = this.ctx
    const fontSize = this.inlineFontSize(tier, marks)
    const weight = marks.bold ? 700 : tier === 'root' ? 700 : tier === 'primary' ? 600 : tier === 'secondary' ? 500 : 400
    const style = marks.italic ? 'italic ' : ''
    ctx.save()
    ctx.font = `${style}${weight} ${fontSize}px ${marks.code ? MONO_FONT_FAMILY : FONT_FAMILY}`
    ctx.textBaseline = 'middle'
    const width = ctx.measureText(text).width

    if (marks.code || marks.highlight) {
      ctx.beginPath()
      ctx.roundRect(x - 1, y - fontSize / 2 - 2, width + 2, fontSize + 4, marks.code ? 4 : 2)
      ctx.fillStyle = marks.code ? 'rgba(127, 132, 143, .24)' : 'rgba(255, 235, 64, .82)'
      ctx.fill()
    }

    ctx.fillStyle = marks.code
      ? '#f08a6e'
      : marks.highlight
        ? '#252525'
      : isDone
        ? this.theme.dim
        : isLink
          ? this.theme.accent
          : tier === 'root'
            ? this.theme.rootText
            : tier === 'primary'
              ? this.theme.primaryText
            : this.theme.text
    ctx.fillText(text, x, y)

    const underline = marks.underline || isLink
    const strike = marks.strike || isDone
    if (underline || strike) {
      ctx.beginPath()
      if (underline) {
        ctx.moveTo(x, y + fontSize / 2 + 2)
        ctx.lineTo(x + width, y + fontSize / 2 + 2)
      }
      if (strike) {
        ctx.moveTo(x, y)
        ctx.lineTo(x + width, y)
      }
      ctx.strokeStyle = ctx.fillStyle
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
    return width
  }

  private inlineFontSize(tier: CanvasNodeTier, marks: InlineMarks): number {
    if (marks.code) return tier === 'root' ? 14 : 13
    if (tier === 'root') return 16
    if (tier === 'primary') return 15
    if (tier === 'secondary') return 14.5
    return FONT_SIZE
  }

  private drawDropIndicator(box: NodeBox): void {
    const ctx = this.ctx
    const theme = this.theme
    if (!this.indicator) return
    if (this.indicator.type === 'child') {
      ctx.beginPath()
      ctx.roundRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8, 8)
      ctx.strokeStyle = theme.accent
      ctx.lineWidth = 2.5 / this.transform.k
      ctx.stroke()
    } else {
      const y = this.indicator.type === 'before' ? box.y - 3 : box.y + box.height + 3
      ctx.beginPath()
      ctx.roundRect(box.x, y - 1.5, box.width, 3, 1.5)
      ctx.fillStyle = theme.accent
      ctx.fill()
    }
  }

  private draggedSubtreeIds(): Set<string> {
    const ids = new Set<string>()
    const source = this.dragPreview && this.state?.root
      ? this.findNode(this.state.root, this.dragPreview.sourceId)
      : null
    if (!source) return ids
    const pending = [source]
    while (pending.length > 0) {
      const node = pending.pop()!
      ids.add(node.id)
      pending.push(...node.children)
    }
    return ids
  }

  private findNode(root: MindmapNode, id: string): MindmapNode | null {
    const pending = [root]
    while (pending.length > 0) {
      const node = pending.pop()!
      if (node.id === id) return node
      pending.push(...node.children)
    }
    return null
  }

  /** 绘制幕布式三层拖动反馈：原位虚线占位、浮动副本、候选落点连线。 */
  private drawDragPreview(preview: CanvasDragPreview, draggedIds: ReadonlySet<string>): void {
    if (!this.layout) return
    const source = this.layout.boxes.get(preview.sourceId)
    if (!source) return

    const ctx = this.ctx
    const lineWidth = 1.6 / this.transform.k

    // 源子树保持完整布局，并用虚线框明确表示“尚未从原位置移除”。
    ctx.save()
    ctx.setLineDash([6 / this.transform.k, 4 / this.transform.k])
    ctx.strokeStyle = this.theme.accent
    ctx.lineWidth = lineWidth
    ctx.globalAlpha = 0.82
    for (const id of draggedIds) {
      const box = this.layout.boxes.get(id)
      if (!box) continue
      ctx.beginPath()
      ctx.roundRect(box.x - 3, box.y - 3, box.width + 6, box.height + 6, 7)
      ctx.stroke()
    }
    ctx.restore()

    const ghostX = preview.pointer.x - preview.offset.x
    const ghostY = preview.pointer.y - preview.offset.y
    const offsetX = ghostX - source.x
    const offsetY = ghostY - source.y

    if (preview.indicator) {
      const target = this.layout.boxes.get(preview.indicator.targetId)
      if (target) {
        this.drawDropIndicator(target)
        const parent = preview.indicator.type === 'child'
          ? target
          : target.node.parent
            ? this.layout.boxes.get(target.node.parent.id) ?? null
            : null
        if (parent) this.drawProvisionalConnector(parent, ghostX, ghostY, source.width, source.height)
      }
    }

    // 后置一层轻微错位边框，表达当前是随指针移动的副本而不是第二个真实节点。
    ctx.save()
    ctx.globalAlpha = 0.88
    ctx.beginPath()
    ctx.roundRect(ghostX + 5, ghostY + 5, source.width, source.height, 7)
    ctx.strokeStyle = this.theme.dim
    ctx.lineWidth = 1.5 / this.transform.k
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.9
    this.drawNode(source, {
      offsetX,
      offsetY,
      selected: false,
      controls: false,
      recordLinkHits: false,
    })
    ctx.restore()

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(ghostX - 2, ghostY - 2, source.width + 4, source.height + 4, 8)
    ctx.strokeStyle = this.theme.accent
    ctx.lineWidth = 2 / this.transform.k
    ctx.stroke()
    ctx.restore()
  }

  private drawProvisionalConnector(
    parent: NodeBox,
    ghostX: number,
    ghostY: number,
    ghostWidth: number,
    ghostHeight: number,
  ): void {
    const ctx = this.ctx
    const x1 = parent.x + parent.width
    const y1 = parent.y + parent.height / 2
    const x2 = ghostX
    const y2 = ghostY + ghostHeight / 2
    const elbowX = x2 >= x1 ? x1 + Math.max(24, (x2 - x1) / 2) : (x1 + x2 + ghostWidth) / 2
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(elbowX, y1)
    ctx.lineTo(elbowX, y2)
    ctx.lineTo(x2, y2)
    ctx.strokeStyle = this.theme.link
    ctx.lineWidth = 2 / this.transform.k
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.restore()
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    if (this.themeMode === 'auto') this.darkMedia?.removeEventListener('change', this.onDarkChange)
    this.canvas.remove()
  }
}
