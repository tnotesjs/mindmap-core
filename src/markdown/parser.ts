/**
 * Markdown → 思维导图文档。
 *
 * 合法文件必须恰好包含一个 H1 根节点；除空行外，H1 前不能有内容，
 * H1 后只能出现无序列表。解析器仍会返回一棵可用的文档树，但调用方
 * 必须以 valid/diagnostics 为准，不能用非法输入覆盖最后一棵合法文档树。
 */

import { MindmapDocument } from '../model/document'
import type { MindmapNode } from '../model/document'
import { parseInline } from '../model/inline'

const H1_RE = /^#(?!#)\s+(\S.*)$/
const LIST_RE = /^(\s*)[-*+]\s+(.*)$/
const CHECK_RE = /^\[( |x|X)\](?:\s+(.*))?$/

export type MarkdownDiagnosticCode =
  | 'missing-h1'
  | 'content-before-h1'
  | 'multiple-h1'
  | 'extra-content'

export interface MarkdownDiagnostic {
  code: MarkdownDiagnosticCode
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  column: number
  message: string
}

export interface ParseResult {
  doc: MindmapDocument
  valid: boolean
  diagnostics: MarkdownDiagnostic[]
  /** 向后兼容：现在表示存在任意非法格式。 */
  hasExtraContent: boolean
}

/** 前导空白换算为列宽：空格 1，Tab 2 */
function indentColumn(whitespace: string): number {
  let col = 0
  for (const ch of whitespace) {
    if (ch === ' ') col += 1
    else if (ch === '\t') col += 2
  }
  return col
}

function firstContentColumn(line: string): number {
  const index = line.search(/\S/)
  return index < 0 ? 1 : index + 1
}

export function parseMarkdown(md: string, fileName = '未命名'): ParseResult {
  const lines = md.split(/\r?\n/)
  const diagnostics: MarkdownDiagnostic[] = []
  const h1Indices: number[] = []

  for (let i = 0; i < lines.length; i++) {
    if (H1_RE.test(lines[i])) h1Indices.push(i)
  }

  const h1Index = h1Indices[0] ?? -1
  if (h1Index < 0) {
    const firstContent = lines.findIndex((line) => line.trim() !== '')
    diagnostics.push({
      code: 'missing-h1',
      line: firstContent >= 0 ? firstContent + 1 : 1,
      column: firstContent >= 0 ? firstContentColumn(lines[firstContent]) : 1,
      message: '文档必须包含且仅包含一个一级标题（H1）作为根节点',
    })
  }

  if (h1Index >= 0) {
    for (let i = 0; i < h1Index; i++) {
      if (lines[i].trim() === '') continue
      diagnostics.push({
        code: 'content-before-h1',
        line: i + 1,
        column: firstContentColumn(lines[i]),
        message: '一级标题前只能有空行',
      })
    }

    for (const index of h1Indices.slice(1)) {
      diagnostics.push({
        code: 'multiple-h1',
        line: index + 1,
        column: 1,
        message: '文档只能包含一个一级标题（H1）',
      })
    }

    for (let i = h1Index + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || LIST_RE.test(line)) continue
      // 第二个 H1 已由更明确的诊断覆盖，避免同一行重复报错。
      if (H1_RE.test(line)) continue
      diagnostics.push({
        code: 'extra-content',
        line: i + 1,
        column: firstContentColumn(line),
        message: '一级标题后只允许空行和无序列表项',
      })
    }
  }

  const titleMatch = h1Index >= 0 ? H1_RE.exec(lines[h1Index]) : null
  const doc = new MindmapDocument(titleMatch?.[1].trim() || fileName)

  if (h1Index >= 0) {
    // stack[d] = 深度 d 的缩进列；depthNode[d] = 深度 d 最近一个节点
    const stack: number[] = []
    const depthNode: MindmapNode[] = []

    for (let i = h1Index + 1; i < lines.length; i++) {
      const m = LIST_RE.exec(lines[i])
      if (!m) continue

      const col = indentColumn(m[1])
      let depth: number
      if (stack.length === 0) {
        stack.push(col)
        depth = 0
      } else if (col > stack[stack.length - 1]) {
        stack.push(col)
        depth = stack.length - 1
      } else {
        while (stack.length > 0 && stack[stack.length - 1] > col) stack.pop()
        if (stack.length === 0) {
          stack.push(col)
          depth = 0
        } else if (stack[stack.length - 1] === col) {
          depth = stack.length - 1
        } else {
          // 比当前层略深但未到下一级：视为下一层
          stack.push(col)
          depth = stack.length - 1
        }
      }

      let checked: boolean | null = null
      let contentRaw = m[2].trim()
      const cm = CHECK_RE.exec(contentRaw)
      if (cm) {
        checked = cm[1].toLowerCase() === 'x'
        contentRaw = (cm[2] ?? '').trim()
      }
      const content = parseInline(contentRaw)
      content.checked = checked

      const parent = depth === 0 ? doc.root : (depthNode[depth - 1] ?? doc.root)
      const node = doc.addNode(parent, content)
      depthNode.length = depth
      depthNode[depth] = node
    }
  }

  return {
    doc,
    valid: diagnostics.length === 0,
    diagnostics,
    hasExtraContent: diagnostics.length > 0,
  }
}
