/**
 * 思维导图文档模型：树结构 + 全部编辑操作。
 * 纯数据层，不依赖 DOM / Vue，可独立单测。
 */

import {
  clearInlineFormats,
  inlineFormatActive,
  parseInline,
  refreshRaw,
  replaceInlineDisplayText,
  setInlineFormat,
  setInlineLink,
  toggleInlineFormat,
  updateInlineLink,
} from './inline'
import type { InlineFormat, NodeContent } from './inline'

export interface MindmapNode {
  id: string
  content: NodeContent
  children: MindmapNode[]
  collapsed: boolean
  parent: MindmapNode | null
}

export interface MindmapNodeJSON {
  id: string
  content: NodeContent
  collapsed: boolean
  children: MindmapNodeJSON[]
}

let nextNodeId = 1

export function createNode(content: NodeContent): MindmapNode {
  return { id: `n${nextNodeId++}`, content, children: [], collapsed: false, parent: null }
}

/** 供测试或重新载入时重置 id 计数 */
export function resetNodeIdCounter(start = 1): void {
  nextNodeId = start
}

export function isAncestor(ancestor: MindmapNode, node: MindmapNode): boolean {
  let p = node.parent
  while (p) {
    if (p === ancestor) return true
    p = p.parent
  }
  return false
}

/** 折叠时视为无可见子节点 */
export function visibleChildren(node: MindmapNode): MindmapNode[] {
  return node.collapsed ? [] : node.children
}

export class MindmapDocument {
  root: MindmapNode

  constructor(title = '未命名') {
    this.root = createNode(parseInline(title))
  }

  find(id: string): MindmapNode | null {
    let found: MindmapNode | null = null
    this.traverse((n) => {
      if (n.id === id) found = n
    })
    return found
  }

  /** 先序遍历；visibleOnly 时跳过折叠节点的子树 */
  traverse(cb: (node: MindmapNode) => void, opts: { visibleOnly?: boolean; from?: MindmapNode } = {}): void {
    const walk = (n: MindmapNode) => {
      cb(n)
      const children = opts.visibleOnly ? visibleChildren(n) : n.children
      for (const c of children) walk(c)
    }
    walk(opts.from ?? this.root)
  }

  addNode(parent: MindmapNode, content: NodeContent, index = parent.children.length): MindmapNode {
    const node = createNode(content)
    node.parent = parent
    const i = Math.max(0, Math.min(index, parent.children.length))
    parent.children.splice(i, 0, node)
    return node
  }

  insertChild(parent: MindmapNode, index = parent.children.length, raw = ''): MindmapNode {
    return this.addNode(parent, parseInline(raw), index)
  }

  /** 在指定节点之后插入同级；node 为根时改为追加子节点 */
  insertAfter(node: MindmapNode, raw = ''): MindmapNode | null {
    if (node === this.root || !node.parent) {
      return this.insertChild(this.root, this.root.children.length, raw)
    }
    const i = node.parent.children.indexOf(node)
    return this.addNode(node.parent, parseInline(raw), i + 1)
  }

  /** 删除节点（根节点不可删），返回删除位置用于选中相邻节点 */
  remove(node: MindmapNode): { parent: MindmapNode; index: number } | null {
    if (node === this.root || !node.parent) return null
    const parent = node.parent
    const index = parent.children.indexOf(node)
    parent.children.splice(index, 1)
    node.parent = null
    return { parent, index }
  }

  /** 移动节点到新父节点的指定位置；不允许移动到自身/后代下 */
  move(node: MindmapNode, newParent: MindmapNode, index: number): boolean {
    if (node === this.root || node === newParent) return false
    if (isAncestor(node, newParent)) return false
    if (!node.parent) return false
    const oldParent = node.parent
    const siblings = oldParent.children
    const oldIndex = siblings.indexOf(node)
    siblings.splice(oldIndex, 1)
    // 调用方通常按移动前的兄弟数组计算落点；同父级向后移动时，
    // 删除源节点会让目标下标左移一位，需要在插入前补偿。
    if (oldParent === newParent && oldIndex < index) index -= 1
    const i = Math.max(0, Math.min(index, newParent.children.length))
    newParent.children.splice(i, 0, node)
    node.parent = newParent
    return true
  }

  /** Tab：成为上一个兄弟节点的最后一个子节点 */
  indent(node: MindmapNode): boolean {
    if (node === this.root || !node.parent) return false
    const siblings = node.parent.children
    const index = siblings.indexOf(node)
    if (index <= 0) return false
    const prev = siblings[index - 1]
    siblings.splice(index, 1)
    prev.children.push(node)
    node.parent = prev
    prev.collapsed = false
    return true
  }

  /** Shift+Tab：提升为父节点的下一个兄弟 */
  outdent(node: MindmapNode): boolean {
    if (node === this.root || !node.parent) return false
    const parent = node.parent
    if (parent === this.root || !parent.parent) {
      // 父节点是根：无更外层可提升
      if (parent === this.root) return false
    }
    const grand = parent.parent
    if (!grand) return false
    const siblings = parent.children
    siblings.splice(siblings.indexOf(node), 1)
    const parentIndex = grand.children.indexOf(parent)
    grand.children.splice(parentIndex + 1, 0, node)
    node.parent = grand
    return true
  }

  /** 用新的行内源码更新节点内容（保留任务状态）。 */
  updateRaw(node: MindmapNode, raw: string): void {
    if (node === this.root) {
      node.content = parseInline(raw.trim() || node.content.raw)
      return
    }
    const checked = node.content.checked
    const next = parseInline(raw)
    next.checked = checked
    node.content = next
  }

  /** 编辑器只提交用户看到的纯文案；已有行内格式和链接地址保持不变。 */
  updateDisplayText(node: MindmapNode, text: string): void {
    if (node === this.root) {
      node.content = parseInline(replaceInlineDisplayText(node.content.raw, text.trim() || node.content.text))
      return
    }
    if (node.content.image) {
      node.content.image.alt = text.trim()
      refreshRaw(node.content)
      return
    }
    const checked = node.content.checked
    const next = parseInline(replaceInlineDisplayText(node.content.raw, text.trim()))
    next.checked = checked
    node.content = next
  }

  toggleInlineFormat(node: MindmapNode, start: number, end: number, format: InlineFormat): void {
    if (node.content.image) return
    const checked = node.content.checked
    const next = parseInline(toggleInlineFormat(node.content.raw, start, end, format))
    next.checked = checked
    node.content = next
  }

  setInlineFormat(node: MindmapNode, format: InlineFormat, enabled: boolean): void {
    if (node.content.image || node.content.text.length === 0) return
    const checked = node.content.checked
    const next = parseInline(setInlineFormat(node.content.raw, 0, node.content.text.length, format, enabled))
    next.checked = checked
    node.content = next
  }

  clearInlineFormats(node: MindmapNode, start = 0, end = node.content.text.length): void {
    if (node.content.image || start === end) return
    const checked = node.content.checked
    const next = parseInline(clearInlineFormats(node.content.raw, start, end))
    next.checked = checked
    node.content = next
  }

  inlineFormatActive(node: MindmapNode, start: number, end: number, format: InlineFormat): boolean {
    return !node.content.image && inlineFormatActive(node.content.raw, start, end, format)
  }

  setInlineLink(node: MindmapNode, start: number, end: number, url: string | null): void {
    if (node.content.image) return
    const checked = node.content.checked
    const next = parseInline(setInlineLink(node.content.raw, start, end, url))
    next.checked = checked
    node.content = next
  }

  updateInlineLink(node: MindmapNode, rawStart: number, rawEnd: number, url: string | null): void {
    if (node.content.image) return
    const checked = node.content.checked
    const next = parseInline(updateInlineLink(node.content.raw, rawStart, rawEnd, url))
    next.checked = checked
    node.content = next
  }

  toggleChecked(node: MindmapNode): void {
    if (node === this.root) return
    const c = node.content
    c.checked = c.checked === null ? false : !c.checked
  }

  /** 添加/移除任务属性；与“完成/未完成”切换分开。 */
  toggleTask(node: MindmapNode): void {
    if (node === this.root) return
    node.content.checked = node.content.checked === null ? false : null
  }

  setImageWidth(node: MindmapNode, width: number | null): void {
    if (!node.content.image) return
    node.content.image.width = width !== null && width > 0 ? Math.round(width) : null
    refreshRaw(node.content)
  }

  toggleCollapse(node: MindmapNode, force?: boolean): void {
    node.collapsed = force ?? !node.collapsed
  }

  search(query: string): MindmapNode[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: MindmapNode[] = []
    this.traverse((n) => {
      if (n.content.text.toLowerCase().includes(q)) out.push(n)
    })
    return out
  }

  nodeCount(): number {
    let count = 0
    this.traverse(() => count++)
    return count
  }
}

/** 深拷贝子树（分配新 id），用于粘贴/复制 */
export function cloneSubtree(node: MindmapNode): MindmapNode {
  const copy = createNode({
    ...node.content,
    image: node.content.image ? { ...node.content.image } : null,
  })
  copy.collapsed = node.collapsed
  copy.children = node.children.map((c) => {
    const child = cloneSubtree(c)
    child.parent = copy
    return child
  })
  return copy
}

export function snapshotDoc(doc: MindmapDocument): string {
  const toJSON = (n: MindmapNode): MindmapNodeJSON => ({
    id: n.id,
    content: { ...n.content, image: n.content.image ? { ...n.content.image } : null },
    collapsed: n.collapsed,
    children: n.children.map(toJSON),
  })
  return JSON.stringify(toJSON(doc.root))
}

export function restoreDoc(json: string): MindmapDocument {
  const data = JSON.parse(json) as MindmapNodeJSON
  const doc = new MindmapDocument('')
  const build = (d: MindmapNodeJSON, parent: MindmapNode | null): MindmapNode => {
    const node: MindmapNode = {
      id: d.id,
      content: { ...d.content, image: d.content.image ? { ...d.content.image } : null },
      collapsed: d.collapsed,
      children: [],
      parent,
    }
    node.children = d.children.map((c) => build(c, node))
    return node
  }
  doc.root = build(data, null)
  return doc
}
