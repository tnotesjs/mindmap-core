import { beforeEach, describe, expect, it } from 'vitest'
import { resetNodeIdCounter } from './model/document'
import { MindmapSession } from './session'

beforeEach(() => resetNodeIdCounter())

function makeSession() {
  return new MindmapSession({ markdown: '# T\n\n- a\n  - a1\n- b\n', fileName: 't.tn-mindmap.md' })
}

describe('MindmapSession', () => {
  it('编辑操作触发 change 并可撤销', () => {
    const s = makeSession()
    const changes: string[] = []
    s.on('change', (md) => changes.push(md))
    const a = s.document.root.children[0]
    s.updateNodeRaw(a.children[0].id, 'a1-updated')
    expect(s.getMarkdown()).toContain('a1-updated')
    expect(changes.length).toBe(1)
    s.undo()
    expect(s.getMarkdown()).not.toContain('a1-updated')
    s.redo()
    expect(s.getMarkdown()).toContain('a1-updated')
  })

  it('transact 把多个操作合并为一条历史', () => {
    const s = makeSession()
    let changes = 0
    s.on('change', () => changes++)
    const a = s.document.root.children[0]
    const a1 = a.children[0]
    // 模拟 Enter 分裂：a1 → a1-前 + 新兄弟 a1-后
    s.transact((doc) => {
      doc.updateRaw(a1, '前半')
      doc.insertAfter(a1, '后半')
    })
    expect(changes).toBe(1)
    expect(s.getMarkdown()).toContain('- 前半')
    expect(s.getMarkdown()).toContain('- 后半')
    s.undo()
    expect(s.getMarkdown()).toContain('- a1')
    expect(s.getMarkdown()).not.toContain('前半')
  })

  it('insertBeforeOf 在指定节点之前插入同级；根节点返回 null', () => {
    const s = makeSession()
    const b = s.document.root.children[1]
    const created = s.insertBeforeOf(b.id)!
    expect(created).not.toBeNull()
    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['a', '', 'b'])
    expect(s.insertBeforeOf(s.document.root.id)).toBeNull()
  })

  it('insertParentOf 在当前主题上方插入空的上级主题', () => {
    const s = makeSession()
    const a1 = s.document.root.children[0].children[0]
    const created = s.insertParentOf(a1.id)!

    expect(created.content.raw).toBe('')
    expect(created.parent?.content.text).toBe('a')
    expect(created.children).toEqual([a1])
    expect(a1.parent).toBe(created)
    expect(s.insertParentOf(s.document.root.id)).toBeNull()
  })

  it('图片插入可先准备 Markdown，持久化成功后再原子提交并支持撤销', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    const before = s.getMarkdown()
    const prepared = s.prepareImageInsertion(a.id, 'assets/shot.png')!

    expect(s.getMarkdown()).toBe(before)
    expect(s.document.root.children).toHaveLength(2)
    expect(prepared.markdown).toContain('- ![截图](assets/shot.png)')

    const inserted = prepared.commit()
    expect(inserted.content.image?.src).toBe('assets/shot.png')
    expect(s.getMarkdown()).toBe(prepared.markdown)
    s.undo()
    expect(s.getMarkdown()).toBe(before)
  })

  it('toggleCollapse 不进历史但广播 collapseChange', () => {
    const s = makeSession()
    let collapseEvents = 0
    s.on('collapseChange', () => collapseEvents++)
    const a = s.document.root.children[0]
    s.toggleCollapse(a.id)
    expect(a.collapsed).toBe(true)
    expect(collapseEvents).toBe(1)
    expect(s.canUndo).toBe(false)
  })

  it('setCollapseLevel 按当前聚焦主题计算相对层级', () => {
    const s = new MindmapSession({
      markdown: '# T\n\n- a\n  - a1\n    - a2\n      - a3\n- b\n  - b1\n',
    })
    const [a, b] = s.document.root.children
    const a1 = a.children[0]
    const a2 = a1.children[0]
    let events = 0
    s.on('collapseChange', () => events++)

    s.setCollapseLevel(1)
    expect(a.collapsed).toBe(true)
    expect(a1.collapsed).toBe(true)
    expect(a2.collapsed).toBe(true)
    expect(b.collapsed).toBe(true)

    s.focusNode(a.id)
    s.setCollapseLevel(2)
    expect(a.collapsed).toBe(false)
    expect(a1.collapsed).toBe(false)
    expect(a2.collapsed).toBe(true)
    // 聚焦范围外的 b 不应被相对层级操作改写。
    expect(b.collapsed).toBe(true)
    expect(events).toBeGreaterThanOrEqual(2)
  })

  it('分级折叠会先展开当前相对根', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n  - a1\n' })
    const root = s.document.root
    s.setCollapsed(root.id, true)
    expect(root.collapsed).toBe(true)

    s.setCollapseLevel(1)

    expect(root.collapsed).toBe(false)
    expect(root.children[0].collapsed).toBe(true)
  })

  it('全部主题命令也会保持当前相对根可见', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n  - a1\n' })
    const root = s.document.root
    s.setCollapsed(root.id, true)

    s.toggleCollapseAll()

    expect(root.collapsed).toBe(false)
    expect(root.children[0].collapsed).toBe(true)
  })

  it('叶子节点也能切换同级分支的展开与折叠', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- branch\n  - child\n- leaf\n' })
    const [branch, leaf] = s.document.root.children

    s.toggleCollapseSiblings(leaf.id)
    expect(branch.collapsed).toBe(true)
    s.toggleCollapseSiblings(leaf.id)
    expect(branch.collapsed).toBe(false)
  })

  it('异步操作可按捕获的 ID 删除原节点，不受后来选择变化影响', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n- b\n' })
    const [a, b] = s.document.root.children
    s.select(a.id)
    const captured = [...s.selectionIds]
    s.select(b.id)

    s.removeNodesByIds(captured)

    expect(s.document.root.children.map((node) => node.content.text)).toEqual(['b'])
    expect(s.document.find(b.id)).toBe(b)
  })

  it('focusNode / exitFocusTo 维护聚焦路径并广播', () => {
    const s = makeSession()
    const paths: string[][] = []
    s.on('focusChange', (titles) => paths.push(titles))
    const a = s.document.root.children[0]
    const a1 = a.children[0]
    s.focusNode(a.id)
    s.focusNode(a1.id)
    expect(s.focusRootNode).toBe(a1)
    s.exitFocusTo(1)
    expect(s.focusRootNode).toBe(a)
    expect(paths).toEqual([['a'], ['a', 'a1'], ['a']])
  })

  it('直接进入深层主题时会重建完整的真实祖先路径', () => {
    const levels = Array.from({ length: 12 }, (_, index) => `${'  '.repeat(index)}- L${index + 1}`)
    const s = new MindmapSession({ markdown: `# T\n\n${levels.join('\n')}\n` })
    const pathEvents: string[][] = []
    s.on('focusChange', (titles) => pathEvents.push(titles))
    let target = s.document.root.children[0]
    while (target.children[0]) target = target.children[0]

    s.focusNode(target.id)

    expect(s.focusPath.map((node) => node.content.text)).toEqual(
      Array.from({ length: 12 }, (_, index) => `L${index + 1}`),
    )
    expect(s.focusRootNode).toBe(target)
    expect(pathEvents).toHaveLength(1)
  })

  it('同层与祖先切换会替换旧后缀，不会把导航历史误当成祖先路径', () => {
    const s = new MindmapSession({
      markdown: '# T\n\n- A\n  - A1\n    - A11\n  - A2\n- B\n',
    })
    const [a, b] = s.document.root.children
    const [a1, a2] = a.children
    const a11 = a1.children[0]
    s.focusNode(a11.id)

    s.focusNode(a2.id)
    expect(s.focusPath.map((node) => node.id)).toEqual([a.id, a2.id])

    s.focusNode(a.id)
    expect(s.focusPath.map((node) => node.id)).toEqual([a.id])

    s.focusNode(b.id)
    expect(s.focusPath.map((node) => node.id)).toEqual([b.id])
  })

  it('面包屑切换按节点 id 精确聚焦重名兄弟并收敛选择', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- 父级\n  - 同名\n  - 同名\n' })
    const parent = s.document.root.children[0]
    const [first, second] = parent.children
    s.select(first.id)

    s.switchFocusNode(second.id)

    expect(s.focusPath.map((node) => node.id)).toEqual([parent.id, second.id])
    expect(s.focusRootNode.id).toBe(second.id)
    expect([...s.selectionIds]).toEqual([second.id])
  })

  it('聚焦文档根会退出全部，exitFocusTo 会安全限制路径下标', () => {
    const s = makeSession()
    const a1 = s.document.root.children[0].children[0]
    s.focusNode(a1.id)

    s.exitFocusTo(999)
    expect(s.focusPath).toHaveLength(2)
    s.exitFocusTo(-10)
    expect(s.focusPath).toEqual([])

    s.focusNode(a1.id)
    s.focusNode(s.document.root.id)
    expect(s.focusPath).toEqual([])
    expect(s.focusRootNode).toBe(s.document.root)
  })

  it('进入已折叠主题时自动展开并广播视图变化', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    a.collapsed = true
    let collapseEvents = 0
    s.on('collapseChange', () => collapseEvents++)
    s.focusNode(a.id)
    expect(a.collapsed).toBe(false)
    expect(s.focusRootNode).toBe(a)
    expect(collapseEvents).toBe(1)
  })

  it('setMarkdown 清空历史并重置聚焦', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    s.focusNode(a.id)
    s.updateNodeRaw(a.id, 'a-new')
    s.setMarkdown('# X\n\n- y\n')
    expect(s.document.root.content.text).toBe('X')
    expect(s.canUndo).toBe(false)
    expect(s.focusPath).toEqual([])
  })

  it('非法源码保留原文和最后一棵合法文档树', () => {
    const s = makeSession()
    const originalDoc = s.document
    const illegal = '- 没有 H1\n- 仍需原样保留\n'
    const validityEvents: string[][] = []
    s.on('validityChange', (items) => validityEvents.push(items.map((item) => item.code)))

    s.setMarkdown(illegal)

    expect(s.isSourceValid).toBe(false)
    expect(s.getMarkdown()).toBe(illegal)
    expect(s.document).toBe(originalDoc)
    expect(s.document.root.content.text).toBe('T')
    expect(s.diagnostics[0]).toMatchObject({ code: 'missing-h1', line: 1 })
    expect(validityEvents).toEqual([['missing-h1']])
  })

  it('非法源码修复后恢复合法文档树，但不强制规范化用户源码', () => {
    const s = makeSession()
    s.setMarkdown('# T\n\n普通段落\n')
    expect(s.isSourceValid).toBe(false)

    const repaired = '# 修复完成\n\n* a\n    * b\n'
    s.setMarkdown(repaired)

    expect(s.isSourceValid).toBe(true)
    expect(s.diagnostics).toEqual([])
    expect(s.getMarkdown()).toBe(repaired)
    expect(s.document.root.content.text).toBe('修复完成')
    expect(s.document.root.children[0].children[0].content.text).toBe('b')
  })

  it('expandAncestors 展开祖先折叠并广播', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    s.toggleCollapse(a.id)
    let events = 0
    s.on('collapseChange', () => events++)
    s.expandAncestors(a.children[0].id)
    // a 是目标节点的祖先且已折叠 → 展开一次
    expect(a.collapsed).toBe(false)
    expect(events).toBe(1)
  })

  it('selectMany 维护有序多选集合与主节点', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    const a1 = a.children[0]
    const b = s.document.root.children[1]

    s.selectMany([a.id, a1.id, b.id], b.id, a.id)
    expect([...s.selectionIds]).toEqual([a.id, a1.id, b.id])
    expect(s.selectedNodes.map((n) => n.content.text)).toEqual(['a', 'a1', 'b'])
    expect(s.selectedNode).toBe(b)
    expect(s.selectionAnchor).toBe(a)

    s.select(a1.id)
    expect([...s.selectionIds]).toEqual([a1.id])
  })

  it('removeSelectedNodes 只删除选择中的顶层子树，并合并为一条历史', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    const a1 = a.children[0]
    const b = s.document.root.children[1]
    s.selectMany([a.id, a1.id, b.id], b.id)

    s.removeSelectedNodes()
    expect(s.document.root.children).toHaveLength(0)
    s.undo()
    expect(s.getMarkdown()).toBe('# T\n\n- a\n  - a1\n- b\n')
  })

  it('removeNodeOnly 仅删除当前主题并原位提升子主题', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n  - a1\n  - a2\n- b\n' })
    const a = s.document.root.children[0]
    s.removeNodeOnly(a.id)
    expect(s.document.root.children.map((node) => node.content.text)).toEqual(['a1', 'a2', 'b'])
    expect(s.selectedNode?.content.text).toBe('a1')
    s.undo()
    expect(s.getMarkdown()).toBe('# T\n\n- a\n  - a1\n  - a2\n- b\n')
  })

  it('多选缩进与提升保持连续节点顺序', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n- b\n- c\n', fileName: 't.tn-mindmap.md' })
    const [a, b, c] = s.document.root.children
    s.selectMany([b.id, c.id], c.id)
    s.indentSelectedNodes()
    expect(a.children.map((n) => n.content.text)).toEqual(['b', 'c'])

    s.outdentSelectedNodes()
    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['a', 'b', 'c'])
  })

  it('多选节点可整体上下移动，并作为一条历史撤销', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n- b\n- c\n- d\n', fileName: 't.tn-mindmap.md' })
    const [, b, c] = s.document.root.children
    s.selectMany([b.id, c.id], c.id, b.id)

    s.moveSelectedNodes(1)
    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['a', 'd', 'b', 'c'])
    s.undo()
    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['a', 'b', 'c', 'd'])

    s.moveSelectedNodes(-1)
    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('duplicateSelectedNodes 深复制连续子树并选中新副本', () => {
    const s = makeSession()
    const [a, b] = s.document.root.children
    s.selectMany([a.id, b.id], b.id, a.id)
    s.duplicateSelectedNodes()

    expect(s.document.root.children.map((n) => n.content.text)).toEqual(['a', 'b', 'a', 'b'])
    const copies = s.document.root.children.slice(2)
    expect(copies[0].children.map((n) => n.content.text)).toEqual(['a1'])
    expect(copies[0].id).not.toBe(a.id)
    expect(s.selectedNodes).toEqual(copies)
    expect(s.selectionAnchor).toBe(copies[0])
  })

  it('批量任务快捷操作区分添加任务与切换完成状态', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- a\n- [x] b\n- c\n', fileName: 't.tn-mindmap.md' })
    const [a, b, c] = s.document.root.children
    s.selectMany([a.id, b.id, c.id], c.id, a.id)

    s.toggleTaskSelectedNodes()
    expect(s.getMarkdown()).toContain('- [ ] a\n- [ ] b\n- [ ] c\n')
    s.toggleCheckedSelectedNodes()
    expect(s.getMarkdown()).toContain('- [x] a\n- [x] b\n- [x] c\n')
    s.toggleTaskSelectedNodes()
    expect(s.getMarkdown()).toContain('- a\n- b\n- c\n')
  })

  it('按可见文案编辑链接 label 时保留 URL，清空 label 时移除链接', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- [桥水官网](https://bridgewater.com)\n' })
    const link = s.document.root.children[0]
    s.updateNodeDisplayText(link.id, '桥水')
    expect(s.getMarkdown()).toContain('- [桥水](https://bridgewater.com)')
    expect(link.content.link).toBe('https://bridgewater.com')

    s.updateNodeDisplayText(link.id, '')
    expect(link.content.raw).toBe('')
    expect(link.content.link).toBeNull()
  })

  it('局部行内格式与链接操作共享会话历史', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- abcdef\n' })
    const node = s.document.root.children[0]
    s.toggleNodeInlineFormat(node.id, 1, 4, 'bold')
    expect(node.content.raw).toBe('a**bcd**ef')
    expect(s.inlineFormatActive(node.id, 1, 4, 'bold')).toBe(true)
    s.setNodeInlineLink(node.id, 1, 4, 'https://example.com')
    expect(node.content.raw).toContain('[**bcd**](https://example.com)')
    s.undo()
    expect(s.document.find(node.id)?.content.raw).toBe('a**bcd**ef')
  })

  it('H1 根主题也可按可见选区格式化并正常序列化', () => {
    const s = new MindmapSession({ markdown: '# Root title\n\n- child\n' })
    const root = s.document.root
    s.toggleNodeInlineFormat(root.id, 0, 4, 'bold')
    expect(root.content.raw).toBe('**Root** title')
    expect(s.getMarkdown()).toContain('# **Root** title')
    s.updateNodeDisplayText(root.id, 'Main title')
    expect(s.getMarkdown()).toContain('# **Main** title')
  })

  it('多节点格式化对混合状态统一添加，并只产生一条撤销历史', () => {
    const s = new MindmapSession({ markdown: '# T\n\n- **a**\n- b\n' })
    const [a, b] = s.document.root.children
    s.selectMany([a.id, b.id], b.id, a.id)
    s.formatSelectedNodes('bold')
    expect(a.content.raw).toBe('**a**')
    expect(b.content.raw).toBe('**b**')
    s.undo()
    expect(s.getMarkdown()).toBe('# T\n\n- **a**\n- b\n')
  })

  it('撤销时聚焦路径重新绑定到恢复后的节点对象', () => {
    const s = makeSession()
    const a = s.document.root.children[0]
    s.focusNode(a.id)
    s.updateNodeRaw(a.id, 'renamed')
    s.undo()

    expect(s.focusRootNode).toBe(s.document.find(a.id))
    expect(s.focusRootNode.content.text).toBe('a')
  })
})
