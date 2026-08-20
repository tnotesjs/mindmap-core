import { beforeEach, describe, expect, it } from 'vitest'
import { MindmapDocument, resetNodeIdCounter } from '../model/document'
import type { TextMeasurer } from './treeLayout'
import { DEFAULT_COLUMN_WIDTH, layoutTree } from './treeLayout'

beforeEach(() => resetNodeIdCounter())

/** 固定测量器：宽 = 字符数 * 10，高 = 20 */
const measurer: TextMeasurer = {
  measure(text: string) {
    return { width: text.length * 10, height: 20 }
  },
}

function makeDoc() {
  const doc = new MindmapDocument('T')
  const a = doc.insertChild(doc.root, 0, 'aa')
  doc.insertChild(a, 0, 'a1')
  doc.insertChild(a, 1, 'a2')
  const b = doc.insertChild(doc.root, 1, 'bb')
  doc.insertChild(b, 0, 'b1')
  return { doc, a, b }
}

describe('layoutTree', () => {
  it('叶子节点 y 顺序递增且不重叠', () => {
    const { doc } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const leaves = [...boxes.values()].filter((b) => b.node.children.length === 0 || b.node.collapsed)
    const sorted = [...leaves].sort((p, q) => p.y - q.y)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].height)
    }
  })

  it('父节点垂直居中于子树跨度', () => {
    const { doc, a } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const boxA = boxes.get(a.id)!
    const first = boxes.get(a.children[0].id)!
    const last = boxes.get(a.children[1].id)!
    const mid = (first.y + last.y + last.height) / 2
    expect(boxA.y + boxA.height / 2).toBeCloseTo(mid)
  })

  it('同父节点的子主题对齐，不同父节点按各自宽度就近排布', () => {
    const { doc, a, b } = makeDoc()
    doc.updateRaw(b, '明显更宽的父主题')
    const { boxes } = layoutTree(doc.root, { measurer })
    const boxA = boxes.get(a.id)!
    const boxB = boxes.get(b.id)!
    expect(boxA.x).toBe(boxB.x)
    expect(boxA.x).toBeGreaterThan(boxes.get(doc.root.id)!.x)
    expect(boxes.get(a.children[0].id)!.x).toBe(boxA.x + boxA.width + 48)
    expect(boxes.get(b.children[0].id)!.x).toBe(boxB.x + boxB.width + 48)
    expect(boxes.get(a.children[0].id)!.x).not.toBe(boxes.get(b.children[0].id)!.x)
  })

  it('某个长叶子不会推动其他分支的后续列', () => {
    const doc = new MindmapDocument('T')
    const leaf = doc.insertChild(doc.root, 0, 'leaf')
    const branch = doc.insertChild(doc.root, 1, 'branch')
    const child = doc.insertChild(branch, 0, 'child')
    const before = layoutTree(doc.root, { measurer })
    const beforeLeafX = before.boxes.get(leaf.id)!.x
    const beforeBranchX = before.boxes.get(branch.id)!.x
    const beforeChildX = before.boxes.get(child.id)!.x

    // 旧算法会把一级叶子的宽度累计到整个二级列，连另一分支的 child 也被推远。
    doc.updateRaw(leaf, '很长的叶子'.repeat(80))
    const after = layoutTree(doc.root, { measurer })

    expect(after.boxes.get(leaf.id)!.x).toBe(beforeLeafX)
    expect(after.boxes.get(branch.id)!.x).toBe(beforeBranchX)
    expect(after.boxes.get(child.id)!.x).toBe(beforeChildX)
  })

  it('长分支节点在宽度上限内折行，子节点与父节点保持间距', () => {
    const { doc, a } = makeDoc()
    doc.updateRaw(a, '很长的分支主题'.repeat(40))
    const { boxes } = layoutTree(doc.root, { measurer, gapX: 48 })
    const parent = boxes.get(a.id)!
    const child = boxes.get(a.children[0].id)!

    expect(parent.width).toBeLessThanOrEqual(DEFAULT_COLUMN_WIDTH)
    expect(parent.textLines.length).toBeGreaterThan(1)
    expect(child.x - (parent.x + parent.width)).toBeGreaterThanOrEqual(48)
  })

  it('更改分支节点长度只移动自己的后代，不推动其它分支', () => {
    const { doc, a, b } = makeDoc()
    const before = layoutTree(doc.root, { measurer })
    const beforeAChildX = before.boxes.get(a.children[0].id)!.x
    const beforeBChildX = before.boxes.get(b.children[0].id)!.x

    doc.updateRaw(a, '分支节点'.repeat(100))
    const after = layoutTree(doc.root, { measurer })

    expect(after.boxes.get(a.children[0].id)!.x).toBeGreaterThan(beforeAChildX)
    expect(after.boxes.get(b.children[0].id)!.x).toBe(beforeBChildX)
  })

  it('折叠节点视为叶子，不布局其子树', () => {
    const { doc, a } = makeDoc()
    doc.toggleCollapse(a, true)
    const { boxes, links } = layoutTree(doc.root, { measurer })
    expect(boxes.has(a.id)).toBe(true)
    expect(boxes.has(a.children[0].id)).toBe(false)
    expect(links.some((l) => l.from === a.id)).toBe(false)
  })

  it('聚焦子树：以指定节点为布局根', () => {
    const { doc, a } = makeDoc()
    const { boxes, width } = layoutTree(doc.root, { measurer, root: a })
    expect(boxes.has(doc.root.id)).toBe(false)
    expect(boxes.get(a.id)!.x).toBe(0)
    expect(boxes.get(a.id)!.depth).toBe(0)
    expect(width).toBeGreaterThan(0)
  })

  it('图片节点尺寸包含图片区域，宽高比未知时用默认值', () => {
    const doc = new MindmapDocument('T')
    const img = doc.insertChild(doc.root, 0, '![图|200](https://example.com/a.png)')
    const { boxes } = layoutTree(doc.root, { measurer })
    const box = boxes.get(img.id)!
    expect(box.width).toBeGreaterThanOrEqual(200)
    // 高 = 文本高 + 图片区（200 / 默认宽高比 1.6）
    expect(box.height).toBeGreaterThan(20 + 200 / 1.6)
  })

  it('任务节点比普通节点宽出 checkbox 的宽度', () => {
    const doc = new MindmapDocument('T')
    const plain = doc.insertChild(doc.root, 0, 'abcd')
    const task = doc.insertChild(doc.root, 1, 'abcd')
    doc.toggleChecked(task)
    const { boxes } = layoutTree(doc.root, { measurer })
    expect(boxes.get(task.id)!.width - boxes.get(plain.id)!.width).toBe(18)
  })

  it('节点宽度上限内折行，数据仍视为单行文本测量结果', () => {
    const doc = new MindmapDocument('T')
    const long = '字'.repeat(80) // 800px at 10/char → 超过 500
    const n = doc.insertChild(doc.root, 0, long)
    const { boxes } = layoutTree(doc.root, { measurer, maxNodeWidth: 500 })
    const box = boxes.get(n.id)!
    expect(box.width).toBeLessThanOrEqual(500)
    expect(box.textLines.length).toBeGreaterThan(1)
    expect(box.textLines.join('')).toBe(long)
    expect(box.height).toBeGreaterThan(20 + 12) // 多行高于单行
  })

  it('短文本不折行且宽度随内容', () => {
    const doc = new MindmapDocument('T')
    const n = doc.insertChild(doc.root, 0, '短')
    const { boxes } = layoutTree(doc.root, { measurer, maxNodeWidth: 500 })
    const box = boxes.get(n.id)!
    expect(box.textLines).toEqual(['短'])
    expect(box.width).toBeLessThan(100)
  })

  it('为层级字号和粗体渲染预留宽度，根节点末字不会被编辑框裁切', () => {
    const doc = new MindmapDocument('abcdefghij')
    const { boxes } = layoutTree(doc.root, { measurer })
    const root = boxes.get(doc.root.id)!
    expect(root.width).toBeGreaterThan(10 * 10 + 24)
  })

  it('千级节点布局耗时在可接受范围（O(n)）', () => {
    const doc = new MindmapDocument('T')
    let remaining = 1200
    const build = (parent: typeof doc.root, depth: number) => {
      if (remaining <= 0 || depth > 6) return
      const n = Math.min(12, remaining)
      for (let i = 0; i < n; i++) {
        remaining--
        const node = doc.insertChild(parent, parent.children.length, `node-${remaining}`)
        build(node, depth + 1)
      }
    }
    build(doc.root, 0)
    const t0 = performance.now()
    const result = layoutTree(doc.root, { measurer })
    const elapsed = performance.now() - t0
    expect(result.boxes.size).toBeGreaterThan(1000)
    expect(elapsed).toBeLessThan(100)
  })
})
