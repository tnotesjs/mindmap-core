/**
 * 思维导图文档 → Markdown。
 * 全量重新生成「H1 + 无序列表」，缩进统一为 2 空格。
 */

import type { MindmapDocument, MindmapNode } from '../model/document'

function serializeItem(node: MindmapNode): string {
  const c = node.content
  const checkbox = c.checked === null ? '' : c.checked ? '[x] ' : '[ ] '
  return checkbox + c.raw
}

export function serializeMarkdown(doc: MindmapDocument): string {
  const lines: string[] = [`# ${doc.root.content.raw.trim()}`]
  const walk = (node: MindmapNode, depth: number) => {
    for (const child of node.children) {
      lines.push(`${'  '.repeat(depth)}- ${serializeItem(child)}`)
      walk(child, depth + 1)
    }
  }
  if (doc.root.children.length > 0) {
    lines.push('')
    walk(doc.root, 0)
  }
  return lines.join('\n') + '\n'
}

/** 序列化任意子树为无序列表片段（不含 H1），用于行级复制/剪切 */
export function serializeSubtree(node: MindmapNode): string {
  const lines: string[] = []
  const walk = (n: MindmapNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- ${serializeItem(n)}`)
    for (const c of n.children) walk(c, depth + 1)
  }
  walk(node, 0)
  return lines.join('\n')
}
