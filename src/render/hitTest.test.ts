import { beforeEach, describe, expect, it } from 'vitest'
import { layoutTree, NODE_PAD_X, type TextMeasurer } from '../layout/treeLayout'
import { MindmapDocument, resetNodeIdCounter } from '../model/document'
import { hitTest, nodeGeometry, resolveNodeControl } from './hitTest'

beforeEach(() => resetNodeIdCounter())

const measurer: TextMeasurer = {
  measure(text: string) {
    return { width: text.length * 10, height: 21 }
  },
}

function makeDoc() {
  const doc = new MindmapDocument('T')
  const task = doc.insertChild(doc.root, 0, 'task')
  doc.toggleChecked(task)
  const link = doc.insertChild(doc.root, 1, '[链接](https://example.com)')
  const img = doc.insertChild(doc.root, 2, '![图|200](https://example.com/a.png)')
  const parent = doc.insertChild(doc.root, 3, 'parent')
  doc.insertChild(parent, 0, 'child')
  return { doc, task, link, img, parent }
}

const aspects = new Map<string, number>()

describe('nodeGeometry', () => {
  it('任务节点有 checkbox 区域，文本右移', () => {
    const { doc, task } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const geo = nodeGeometry(boxes.get(task.id)!, aspects, false)
    expect(geo.checkboxRect).not.toBeNull()
    expect(geo.textX).toBe(NODE_PAD_X + 18)
  })

  it('图片节点有图片区域；仅选中时给出 resize 手柄', () => {
    const { doc, img } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const box = boxes.get(img.id)!
    const unselected = nodeGeometry(box, aspects, false)
    expect(unselected.imageRect).not.toBeNull()
    expect(unselected.imageRect!.w).toBe(200)
    expect(unselected.resizeHandle).toBeNull()
    const selected = nodeGeometry(box, aspects, true)
    expect(selected.resizeHandle).not.toBeNull()
  })

  it('根和普通父节点都有折叠圆点，叶子没有', () => {
    const { doc, parent, task } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    expect(nodeGeometry(boxes.get(doc.root.id)!, aspects, false).collapseDot).not.toBeNull()
    expect(nodeGeometry(boxes.get(parent.id)!, aspects, false).collapseDot).not.toBeNull()
    expect(nodeGeometry(boxes.get(task.id)!, aspects, false).collapseDot).toBeNull()
  })

  it('选中叶子也会获得新增子主题动作圆环', () => {
    const { doc, task } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    expect(nodeGeometry(boxes.get(task.id)!, aspects, false).controlDot).toBeNull()
    expect(nodeGeometry(boxes.get(task.id)!, aspects, true).controlDot).not.toBeNull()
  })
})

describe('hitTest', () => {
  it('命中节点主体', () => {
    const { doc, task } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const box = boxes.get(task.id)!
    const hit = hitTest(boxes.values(), box.x + box.width - 5, box.y + box.height / 2, {
      selectedId: null,
      imageAspects: aspects,
    })
    expect(hit).toEqual({ id: task.id, role: 'body' })
  })

  it('命中 checkbox / 折叠圆点 / 图片 / resize 手柄', () => {
    const { doc, task, img, parent } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const opts = { selectedId: img.id, imageAspects: aspects, hoveredId: parent.id }

    const taskBox = boxes.get(task.id)!
    const cb = nodeGeometry(taskBox, aspects, false).checkboxRect!
    expect(
      hitTest(boxes.values(), taskBox.x + cb.x + 2, taskBox.y + cb.y + 2, opts),
    ).toEqual({ id: task.id, role: 'checkbox' })

    const parentBox = boxes.get(parent.id)!
    const dot = nodeGeometry(parentBox, aspects, false).collapseDot!
    expect(hitTest(boxes.values(), dot.cx, dot.cy, opts)).toEqual({ id: parent.id, role: 'collapse' })

    const imgBox = boxes.get(img.id)!
    const ir = nodeGeometry(imgBox, aspects, true).imageRect!
    expect(
      hitTest(boxes.values(), imgBox.x + ir.x + ir.w / 2, imgBox.y + ir.y + ir.h / 2, opts),
    ).toEqual({ id: img.id, role: 'image' })

    const handle = nodeGeometry(imgBox, aspects, true).resizeHandle!
    expect(hitTest(boxes.values(), handle.cx, handle.cy, opts)).toEqual({ id: img.id, role: 'resize' })
  })

  it('展开控件仅 hover 后可命中，折叠计数控件始终可命中', () => {
    const { doc, parent } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    const parentBox = boxes.get(parent.id)!
    const dot = nodeGeometry(parentBox, aspects, false).collapseDot!
    const point = { x: dot.cx + 5, y: dot.cy }

    expect(hitTest(boxes.values(), point.x, point.y, {
      selectedId: null,
      imageAspects: aspects,
      hoveredId: null,
    })).toBeNull()
    expect(hitTest(boxes.values(), point.x, point.y, {
      selectedId: null,
      imageAspects: aspects,
      hoveredId: parent.id,
    })).toEqual({ id: parent.id, role: 'collapse' })

    parent.collapsed = true
    expect(hitTest(boxes.values(), point.x, point.y, {
      selectedId: null,
      imageAspects: aspects,
      hoveredId: null,
    })).toEqual({ id: parent.id, role: 'collapse' })
  })

  it('单选的新增按钮优先于 hover 收起与折叠数量，多选不展示新增按钮', () => {
    const { doc, parent, task } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })

    expect(resolveNodeControl(parent, true, parent.id)).toBe('add')
    parent.collapsed = true
    expect(resolveNodeControl(parent, true, parent.id)).toBe('add')
    expect(resolveNodeControl(parent, false, null)).toBe('count')

    const leafBox = boxes.get(task.id)!
    const add = nodeGeometry(leafBox, aspects, true).controlDot!
    expect(hitTest(boxes.values(), add.cx, add.cy, {
      selectedId: task.id,
      selectionCount: 1,
      imageAspects: aspects,
    })).toEqual({ id: task.id, role: 'add' })
    expect(hitTest(boxes.values(), add.cx, add.cy, {
      selectedId: task.id,
      selectionCount: 2,
      imageAspects: aspects,
    })).toEqual({ id: task.id, role: 'body' })
  })

  it('空白处返回 null', () => {
    const { doc } = makeDoc()
    const { boxes } = layoutTree(doc.root, { measurer })
    expect(hitTest(boxes.values(), -1000, -1000, { selectedId: null, imageAspects: aspects })).toBeNull()
  })
})
