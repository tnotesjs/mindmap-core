import { beforeEach, describe, expect, it } from 'vitest'
import { MindmapDocument, resetNodeIdCounter, restoreDoc, snapshotDoc } from './document'

beforeEach(() => resetNodeIdCounter())

/** T - a - a1,a2 ; T - b */
function makeDoc() {
  const doc = new MindmapDocument('T')
  const a = doc.insertChild(doc.root, 0, 'a')
  doc.insertChild(a, 0, 'a1')
  doc.insertChild(a, 1, 'a2')
  const b = doc.insertChild(doc.root, 1, 'b')
  return { doc, a, b }
}

describe('MindmapDocument 结构操作', () => {
  it('insertChild / insertAfter 维护父子关系', () => {
    const { doc, a } = makeDoc()
    const c = doc.insertChild(a, 1, 'x')
    expect(a.children.map((n) => n.content.text)).toEqual(['a1', 'x', 'a2'])
    expect(c.parent).toBe(a)

    const s = doc.insertAfter(c, 'y')!
    expect(a.children.map((n) => n.content.text)).toEqual(['a1', 'x', 'y', 'a2'])
    expect(s.parent).toBe(a)
  })

  it('根节点上 insertAfter 退化为追加子节点', () => {
    const { doc } = makeDoc()
    const n = doc.insertAfter(doc.root, 'c')!
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['a', 'b', 'c'])
    expect(n.parent).toBe(doc.root)
  })

  it('remove 删除节点并返回位置；根节点不可删', () => {
    const { doc, a } = makeDoc()
    const pos = doc.remove(a)!
    expect(pos.parent).toBe(doc.root)
    expect(pos.index).toBe(0)
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['b'])
    expect(doc.remove(doc.root)).toBeNull()
  })

  it('move 移动子树；禁止移动到自身或后代下', () => {
    const { doc, a, b } = makeDoc()
    expect(doc.move(a.children[0], b, 0)).toBe(true)
    expect(b.children.map((n) => n.content.text)).toEqual(['a1'])
    expect(a.children.map((n) => n.content.text)).toEqual(['a2'])

    expect(doc.move(a, a.children[0], 0)).toBe(false)
    expect(doc.move(a, a, 0)).toBe(false)
    expect(doc.move(doc.root, b, 0)).toBe(false)
  })

  it('同父级向后移动时按移动前下标补偿，落在目标节点之后', () => {
    const doc = new MindmapDocument('T')
    const a = doc.insertChild(doc.root, 0, 'a')
    const b = doc.insertChild(doc.root, 1, 'b')
    doc.insertChild(doc.root, 2, 'c')

    // UI 在移动前计算 b 的下标 1，after 落点传入 2。
    expect(doc.move(a, doc.root, doc.root.children.indexOf(b) + 1)).toBe(true)
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['b', 'a', 'c'])
  })

  it('indent 成为上一个兄弟的最后一个子节点；首个兄弟不可缩进', () => {
    const { doc, a, b } = makeDoc()
    expect(doc.indent(b)).toBe(true)
    expect(a.children.map((n) => n.content.text)).toEqual(['a1', 'a2', 'b'])
    expect(b.parent).toBe(a)

    const first = doc.insertChild(doc.root, 0, 'first')
    expect(doc.indent(first)).toBe(false)
  })

  it('indent 时目标兄弟若为折叠状态会自动展开', () => {
    const { doc, a, b } = makeDoc()
    doc.toggleCollapse(a, true)
    doc.indent(b)
    expect(a.collapsed).toBe(false)
  })

  it('outdent 提升为父节点的下一个兄弟；根的直接子节点不可提升', () => {
    const { doc, a, b } = makeDoc()
    const a1 = a.children[0]
    expect(doc.outdent(a1)).toBe(true)
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['a', 'a1', 'b'])
    expect(a1.parent).toBe(doc.root)

    expect(doc.outdent(b)).toBe(false)
    expect(doc.outdent(doc.root)).toBe(false)
  })
})

describe('MindmapDocument 内容操作', () => {
  it('updateRaw 重新解析行内内容并保留任务状态', () => {
    const { doc, a } = makeDoc()
    doc.toggleChecked(a)
    doc.updateRaw(a, '[链接](https://example.com)')
    expect(a.content.link).toBe('https://example.com')
    expect(a.content.checked).toBe(false)
  })

  it('根节点 updateRaw 同样支持语义行内格式与链接', () => {
    const { doc } = makeDoc()
    doc.updateRaw(doc.root, '[x](https://example.com)')
    expect(doc.root.content.link).toBe('https://example.com')
    expect(doc.root.content.text).toBe('x')
    doc.toggleInlineFormat(doc.root, 0, 1, 'bold')
    expect(doc.root.content.raw).toBe('[**x**](https://example.com)')
  })

  it('toggleChecked 在 无 → 未完成 → 已完成 之间切换', () => {
    const { doc, a } = makeDoc()
    expect(a.content.checked).toBeNull()
    doc.toggleChecked(a)
    expect(a.content.checked).toBe(false)
    doc.toggleChecked(a)
    expect(a.content.checked).toBe(true)
  })

  it('setImageWidth 重新生成 raw（Obsidian 风格 |宽度）', () => {
    const doc = new MindmapDocument('T')
    const img = doc.insertChild(doc.root, 0, '![图](https://example.com/a.png)')
    doc.setImageWidth(img, 240)
    expect(img.content.image?.width).toBe(240)
    expect(img.content.raw).toBe('![图|240](https://example.com/a.png)')
    doc.setImageWidth(img, null)
    expect(img.content.raw).toBe('![图](https://example.com/a.png)')
  })

  it('search 按展示文本匹配并返回先序结果', () => {
    const { doc } = makeDoc()
    doc.insertChild(doc.root, 2, 'Apple pie')
    const hits = doc.search('a')
    expect(hits.map((n) => n.content.text)).toEqual(['a', 'a1', 'a2', 'Apple pie'])
    expect(doc.search('')).toEqual([])
    expect(doc.search('zzz')).toEqual([])
  })
})

describe('快照与恢复', () => {
  it('snapshot/restore 保留结构、内容与折叠状态', () => {
    const { doc, a } = makeDoc()
    doc.toggleChecked(a)
    doc.toggleCollapse(a, true)
    const snap = snapshotDoc(doc)
    const restored = restoreDoc(snap)
    expect(snapshotDoc(restored)).toBe(snap)
    const ra = restored.find(a.id)!
    expect(ra.content.checked).toBe(false)
    expect(ra.collapsed).toBe(true)
    expect(ra.children[0].parent).toBe(ra)
  })
})
