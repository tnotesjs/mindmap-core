/**
 * 命中检测与节点几何计算（纯函数，可单测）。
 * Canvas 渲染器与画布编辑器共用同一套几何，保证「画出来的」和「点得到的」一致。
 */

import type { NodeBox } from '../layout/treeLayout'
import {
  CHECKBOX_WIDTH,
  DEFAULT_IMAGE_ASPECT,
  DEFAULT_IMAGE_WIDTH,
  NODE_PAD_X,
  NODE_PAD_Y,
  TEXT_LINE_HEIGHT,
} from '../layout/treeLayout'

export type HitRole = 'body' | 'checkbox' | 'add' | 'collapse' | 'link' | 'image' | 'resize'

export type NodeControlKind = 'add' | 'collapse' | 'count'

export interface HitResult {
  id: string
  role: HitRole
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface NodeGeometry {
  isRoot: boolean
  /** 文本起点（相对节点左上角） */
  textX: number
  /** 第一行文本基线中心 Y（相对节点左上角） */
  textY: number
  /** 文本行数（用于多行绘制） */
  textLineCount: number
  checkboxRect: Rect | null
  imageRect: Rect | null
  /** 节点右侧动作圆环（新增 / 收起 / 折叠数量共用同一几何）。 */
  controlDot: { cx: number; cy: number; r: number } | null
  /** 折叠圆点（世界坐标） */
  collapseDot: { cx: number; cy: number; r: number } | null
  /** 保留字段供几何消费者兼容；链接现在直接命中文字，不再绘制额外跳转图标。 */
  linkIconRect: Rect | null
  /** 图片调宽手柄（世界坐标，仅选中时存在） */
  resizeHandle: { cx: number; cy: number; r: number } | null
}

const CHECKBOX_SIZE = 13
/** 幕布式折叠控件的可视圆环半径。 */
const COLLAPSE_R = 9
const RESIZE_R = 6

/**
 * 幕布式右侧动作优先级：
 * 1. 单选（编辑态也会保持单选）始终展示新增子主题；
 * 2. 未选中的折叠主题展示全部后代数量；
 * 3. 未选中的展开主题仅在 hover 时展示收起图标。
 */
export function resolveNodeControl(
  node: NodeBox['node'],
  selected: boolean,
  hoveredId: string | null,
): NodeControlKind | null {
  if (selected) return 'add'
  if (node.children.length === 0) return null
  if (node.collapsed) return 'count'
  return node.id === hoveredId ? 'collapse' : null
}

export function nodeGeometry(
  box: NodeBox,
  imageAspects: ReadonlyMap<string, number>,
  selected: boolean,
): NodeGeometry {
  const node = box.node
  const isRoot = box.depth === 0
  const hasCheckbox = !isRoot && node.content.checked !== null
  const hasImage = node.content.image !== null
  const lineCount = Math.max(1, box.textLines?.length ?? 1)
  const textBlockH = lineCount * TEXT_LINE_HEIGHT

  const textX = NODE_PAD_X + (hasCheckbox ? CHECKBOX_WIDTH : 0)
  const textY = hasImage
    ? NODE_PAD_Y + TEXT_LINE_HEIGHT / 2
    : (box.height - textBlockH) / 2 + TEXT_LINE_HEIGHT / 2

  let imageRect: Rect | null = null
  let resizeHandle: NodeGeometry['resizeHandle'] = null
  if (node.content.image) {
    const img = node.content.image
    let iw = img.width ?? DEFAULT_IMAGE_WIDTH
    iw = Math.min(iw, box.width - NODE_PAD_X * 2)
    const aspect = imageAspects.get(img.src) || DEFAULT_IMAGE_ASPECT
    const ih = iw / aspect
    imageRect = {
      x: (box.width - iw) / 2,
      y: NODE_PAD_Y + textBlockH + 3,
      w: iw,
      h: ih,
    }
    if (selected) {
      resizeHandle = {
        cx: box.x + imageRect.x + iw,
        cy: box.y + imageRect.y + ih,
        r: RESIZE_R,
      }
    }
  }

  return {
    isRoot,
    textX,
    textY,
    textLineCount: lineCount,
    checkboxRect: hasCheckbox
      ? { x: NODE_PAD_X, y: box.height / 2 - CHECKBOX_SIZE / 2, w: CHECKBOX_SIZE, h: CHECKBOX_SIZE }
      : null,
    imageRect,
    controlDot:
      selected || node.children.length > 0
        ? { cx: box.x + box.width, cy: box.y + box.height / 2, r: COLLAPSE_R }
        : null,
    collapseDot:
      node.children.length > 0 ? { cx: box.x + box.width, cy: box.y + box.height / 2, r: COLLAPSE_R } : null,
    linkIconRect: null,
    resizeHandle,
  }
}

function inRect(px: number, py: number, rect: Rect, base: { x: number; y: number }): boolean {
  return px >= base.x + rect.x && px <= base.x + rect.x + rect.w && py >= base.y + rect.y && py <= base.y + rect.y + rect.h
}

function inCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return Math.hypot(px - cx, py - cy) <= r
}

export interface HitTestOptions {
  selectedId: string | null
  /** 只有单选节点显示新增按钮；多选时右侧不抢占批量操作。 */
  selectionCount?: number
  imageAspects: ReadonlyMap<string, number>
  /**
   * 展开状态的折叠控件仅在节点 hover 后出现，也只有此时才可命中。
   * 已折叠节点的计数圆环始终可见、无需 hover 即可命中。
   */
  hoveredId?: string | null
}

/** 世界坐标命中检测；返回 null 表示点在空白处 */
export function hitTest(
  boxes: Iterable<NodeBox>,
  x: number,
  y: number,
  opts: HitTestOptions,
): HitResult | null {
  for (const box of boxes) {
    if (x < box.x - 6 || x > box.x + box.width + 14 || y < box.y - 6 || y > box.y + box.height + 6) continue
    const geo = nodeGeometry(box, opts.imageAspects, box.id === opts.selectedId)

    if (geo.resizeHandle && inCircle(x, y, geo.resizeHandle.cx, geo.resizeHandle.cy, geo.resizeHandle.r + 4)) {
      return { id: box.id, role: 'resize' }
    }
    const selected = box.id === opts.selectedId && (opts.selectionCount ?? (opts.selectedId ? 1 : 0)) === 1
    const control = resolveNodeControl(box.node, selected, opts.hoveredId ?? null)
    if (
      control &&
      geo.controlDot &&
      inCircle(x, y, geo.controlDot.cx, geo.controlDot.cy, geo.controlDot.r + 4)
    ) {
      return { id: box.id, role: control === 'add' ? 'add' : 'collapse' }
    }
    if (geo.checkboxRect && inRect(x, y, geo.checkboxRect, box)) {
      return { id: box.id, role: 'checkbox' }
    }
    if (geo.linkIconRect && inRect(x, y, geo.linkIconRect, box)) {
      return { id: box.id, role: 'link' }
    }
    if (geo.imageRect && inRect(x, y, geo.imageRect, box)) {
      return { id: box.id, role: 'image' }
    }
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
      return { id: box.id, role: 'body' }
    }
  }
  return null
}
