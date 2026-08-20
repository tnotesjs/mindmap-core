/**
 * 右向紧凑树布局。
 * - 纯计算，不依赖 DOM；文本/图片尺寸通过参数注入，可独立单测。
 * - 局部横向布局：子节点相对自己的父节点就近排布；同父节点对齐，不同分支互不牵连。
 * - y 分配：叶子顺序占槽，父节点居中于子树跨度。
 * - 折叠节点视为叶子；聚焦时以传入的子树根为布局根。
 */

import { visibleChildren } from '../model/document'
import type { MindmapNode } from '../model/document'

export interface TextMeasurer {
  measure(text: string): { width: number; height: number }
}

export interface NodeBox {
  id: string
  node: MindmapNode
  x: number
  y: number
  width: number
  height: number
  depth: number
  /** 所属一级分支（根的直接子节点）；根节点分支为自身 */
  branch: MindmapNode
  /** 布局时按最大宽度折行后的文本行（数据源仍为一行） */
  textLines: string[]
}

export interface LinkPair {
  from: string
  to: string
}

export interface LayoutResult {
  boxes: Map<string, NodeBox>
  links: LinkPair[]
  width: number
  height: number
}

export interface LayoutOptions {
  measurer: TextMeasurer
  /** 图片 src → 宽高比（width/height）；0 表示加载失败；未知用默认值 */
  imageAspects?: ReadonlyMap<string, number>
  /** 聚焦子树时的布局根；默认文档根 */
  root?: MindmapNode
  gapX?: number
  gapY?: number
  padX?: number
  padY?: number
  /** 节点外框最大宽度（含 padding）；文本超出后折行 */
  maxNodeWidth?: number
  /** 有子节点主题的宽度上限；用于限制单个分支自身的横向扩张。 */
  columnWidth?: number
}

/** 渲染层与编辑器共享的尺寸常量 */
export const NODE_PAD_X = 12
export const NODE_PAD_Y = 6
export const CHECKBOX_WIDTH = 18
export const DEFAULT_IMAGE_WIDTH = 120
export const DEFAULT_IMAGE_ASPECT = 1.6
/** 脑图节点宽度上限 */
export const NODE_MAX_WIDTH = 500
/** 有子节点主题的默认宽度上限 */
export const DEFAULT_COLUMN_WIDTH = 220
export const TEXT_LINE_HEIGHT = 21

/**
 * 按最大宽度把单行文本折成多行（不插入数据换行符，仅用于测量/渲染）。
 * 按 Unicode 码点逐字累加，适合中英文混排。
 */
export function wrapTextLines(
  text: string,
  maxWidth: number,
  measureWidth: (s: string) => number,
): string[] {
  const src = text.length > 0 ? text : ' '
  if (maxWidth <= 0 || measureWidth(src) <= maxWidth) return [src]
  const lines: string[] = []
  let line = ''
  for (const ch of src) {
    const next = line + ch
    if (line.length > 0 && measureWidth(next) > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = next
    }
  }
  if (line.length > 0) lines.push(line)
  return lines.length > 0 ? lines : [' ']
}

export function layoutTree(docRoot: MindmapNode, opts: LayoutOptions): LayoutResult {
  const gapX = opts.gapX ?? 48
  const gapY = opts.gapY ?? 10
  const padX = opts.padX ?? NODE_PAD_X
  const padY = opts.padY ?? NODE_PAD_Y
  const maxNodeWidth = opts.maxNodeWidth ?? NODE_MAX_WIDTH
  const columnWidth = Math.min(maxNodeWidth, Math.max(40, opts.columnWidth ?? DEFAULT_COLUMN_WIDTH))
  const root = opts.root ?? docRoot
  const measurer = opts.measurer
  const aspects = opts.imageAspects
  const measureW = (s: string) => measurer.measure(s).width
  const lineH = Math.max(measurer.measure('中').height, TEXT_LINE_HEIGHT)

  const sizes = new Map<string, { w: number; h: number; lines: string[] }>()
  const measureNode = (n: MindmapNode, depth: number): void => {
    const cbW = n !== root && n.content.checked !== null ? CHECKBOX_WIDTH : 0
    // 分支节点限制最大宽度，避免一条超长主题让自己的全部后代被推得过远。
    // 叶子没有后续连线，可使用更大的 maxNodeWidth。
    const widthLimit = n !== root && n.children.length > 0 ? columnWidth : maxNodeWidth
    /*
     * Canvas 的层级字号/字重高于基础 14px 测量器。这里预留稳定比例，避免根节点、
     * 一级节点或粗体片段在渲染/进入编辑时多出最后一个字并被外框裁切。
     */
    const textScale = depth === 0 ? 1.2 : depth === 1 ? 1.12 : depth === 2 ? 1.08 : 1.06
    const nodeMeasureW = (text: string) => measureW(text) * textScale
    const textMax = Math.max(40, widthLimit - padX * 2 - cbW)
    const lines = wrapTextLines(n.content.text || ' ', textMax, nodeMeasureW)
    const textW = Math.max(...lines.map((l) => nodeMeasureW(l)))
    let w = Math.min(widthLimit, textW + padX * 2 + cbW)
    let h = lines.length * lineH + padY * 2
    if (n.content.image) {
      let iw = n.content.image.width ?? DEFAULT_IMAGE_WIDTH
      iw = Math.min(iw, widthLimit - padX * 2)
      const aspect = aspects?.get(n.content.image.src) || DEFAULT_IMAGE_ASPECT
      const ih = iw / Math.max(aspect, 0.15)
      w = Math.min(widthLimit, Math.max(w, iw + padX * 2))
      h += ih + 6
    }
    sizes.set(n.id, { w, h, lines })
    for (const c of visibleChildren(n)) measureNode(c, depth + 1)
  }
  measureNode(root, 0)

  const boxes = new Map<string, NodeBox>()
  const links: LinkPair[] = []
  let cursor = 0

  const place = (
    n: MindmapNode,
    depth: number,
    branch: MindmapNode,
    x: number,
  ): { top: number; bottom: number } => {
    const size = sizes.get(n.id)!
    const kids = visibleChildren(n)
    let y: number
    let top: number
    let bottom: number

    if (kids.length === 0) {
      y = cursor
      top = y
      bottom = y + size.h
      cursor = bottom + gapY
    } else {
      let first: { top: number; bottom: number } | null = null
      let last: { top: number; bottom: number } | null = null
      for (const c of kids) {
        // 每组兄弟节点只对齐到自己的父节点右侧。父节点宽度变化只移动这棵子树，
        // 不再强迫其它分支的同深度节点跟随全局最宽列。
        const span = place(c, depth + 1, depth === 0 ? c : branch, x + size.w + gapX)
        if (!first) first = span
        last = span
        links.push({ from: n.id, to: c.id })
      }
      const mid = (first!.top + last!.bottom) / 2
      y = mid - size.h / 2
      top = Math.min(y, first!.top)
      bottom = Math.max(y + size.h, last!.bottom)
      cursor = Math.max(cursor, bottom + gapY)
    }

    boxes.set(n.id, {
      id: n.id,
      node: n,
      x,
      y,
      width: size.w,
      height: size.h,
      depth,
      branch,
      textLines: size.lines,
    })
    return { top, bottom }
  }
  place(root, 0, root, 0)

  // 不同分支拥有独立横坐标，因此画布宽度取所有实际节点的最右边界。
  let width = 0
  for (const box of boxes.values()) width = Math.max(width, box.x + box.width)
  return { boxes, links, width, height: cursor }
}
