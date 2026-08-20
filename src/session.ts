/**
 * MindmapSession：无头会话层。
 * 持有文档、历史栈、选中、折叠、聚焦路径与搜索高亮，对外暴露全部编辑操作与事件。
 * 不依赖 DOM，可被脑图（Canvas）、大纲（DOM 列表）、源码（textarea）三个视图共享。
 */

import { History } from './commands/history'
import { parseMarkdown } from './markdown/parser'
import type { MarkdownDiagnostic } from './markdown/parser'
import { serializeMarkdown } from './markdown/serializer'
import { cloneSubtree, isAncestor, MindmapDocument, restoreDoc, snapshotDoc } from './model/document'
import { parseInline } from './model/inline'
import type { InlineFormat } from './model/inline'
import type { MindmapNode } from './model/document'

export interface SessionOptions {
  markdown?: string
  fileName?: string
}

export interface PreparedDocumentChange {
  /** 应先持久化该 Markdown，成功后再调用 commit。 */
  readonly markdown: string
  commit(): MindmapNode
}

export interface SessionEvents {
  /** 文档变更，payload 为最新 markdown */
  change: string
  selectionChange: string | null
  /** 折叠/展开（视图态变化，markdown 不变） */
  collapseChange: null
  /** 聚焦路径变化，payload 为从根到聚焦根的标题数组 */
  focusChange: string[]
  /** 警告信息（如文件含非脑图内容） */
  warning: string
  /** 源码合法性变化；空数组表示当前源码合法。 */
  validityChange: readonly MarkdownDiagnostic[]
  /** 搜索高亮集合变化 */
  matchChange: null
}

type Handler<T> = (payload: T) => void

export class MindmapSession {
  private doc: MindmapDocument
  private history = new History()
  private selectedId: string | null = null
  private selectionIdsState = new Set<string>()
  private selectionAnchorId: string | null = null
  private matchIds = new Set<string>()
  private focusStack: MindmapNode[] = []
  private fileName: string
  /** 用户当前看到的原始源码；非法时绝不被文档树的序列化结果覆盖。 */
  private sourceMarkdown = ''
  private diagnosticsState: MarkdownDiagnostic[] = []
  private listeners = new Map<keyof SessionEvents, Set<Handler<never>>>()

  constructor(options: SessionOptions = {}) {
    this.fileName = options.fileName ?? '未命名'
    this.sourceMarkdown = options.markdown ?? `# ${this.cleanFileName()}\n`
    const result = parseMarkdown(this.sourceMarkdown, this.cleanFileName())
    this.doc = result.doc
    this.diagnosticsState = result.diagnostics
  }

  // ---------- 事件 ----------

  on<K extends keyof SessionEvents>(event: K, handler: Handler<SessionEvents[K]>): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler as Handler<never>)
  }

  private emit<K extends keyof SessionEvents>(event: K, payload: SessionEvents[K]): void {
    this.listeners.get(event)?.forEach((h) => (h as Handler<SessionEvents[K]>)(payload))
  }

  off<K extends keyof SessionEvents>(event: K, handler: Handler<SessionEvents[K]>): void {
    this.listeners.get(event)?.delete(handler as Handler<never>)
  }

  /** 视图层直接改文档后，把「变更前快照」补记进历史（如图片拖动调宽），并广播变更 */
  recordSnapshot(snapshot: string): void {
    this.history.record(snapshot)
    this.syncSourceFromDocument()
    this.emit('change', this.getMarkdown())
  }

  // ---------- 基础访问 ----------

  get document(): MindmapDocument {
    return this.doc
  }

  get focusRootNode(): MindmapNode {
    return this.focusStack.length > 0 ? this.focusStack[this.focusStack.length - 1] : this.doc.root
  }

  get focusPath(): MindmapNode[] {
    return [...this.focusStack]
  }

  get selectedNode(): MindmapNode | null {
    return this.selectedId ? this.doc.find(this.selectedId) : null
  }

  /** 当前节点选择集合；selectedNode 是其中的主节点（键盘操作锚点）。 */
  get selectionIds(): ReadonlySet<string> {
    return this.selectionIdsState
  }

  get selectionAnchor(): MindmapNode | null {
    return this.selectionAnchorId ? this.doc.find(this.selectionAnchorId) : null
  }

  /** 按文档先序排列的全部已选节点。 */
  get selectedNodes(): MindmapNode[] {
    const out: MindmapNode[] = []
    this.doc.traverse((node) => {
      if (this.selectionIdsState.has(node.id)) out.push(node)
    })
    return out
  }

  get matches(): ReadonlySet<string> {
    return this.matchIds
  }

  get isSourceValid(): boolean {
    return this.diagnosticsState.length === 0
  }

  get diagnostics(): readonly MarkdownDiagnostic[] {
    return this.diagnosticsState
  }

  getMarkdown(): string {
    return this.sourceMarkdown
  }

  /**
   * 外部同步（源码视图输入 / 打开新文件），不进入撤销历史。
   * 非法源码只更新原文和诊断，最后一棵合法文档树保持不变。
   */
  setMarkdown(md: string): void {
    const result = parseMarkdown(md, this.cleanFileName())
    this.sourceMarkdown = md
    this.diagnosticsState = result.diagnostics
    if (result.valid) {
      this.doc = result.doc
      this.history.clear()
      this.focusStack = []
      this.reconcileSelection()
    }
    this.emit('validityChange', this.diagnostics)
    this.emit('change', this.getMarkdown())
    if (result.valid) this.emit('focusChange', this.focusTitles())
  }

  get canUndo(): boolean {
    return this.history.canUndo
  }

  get canRedo(): boolean {
    return this.history.canRedo
  }

  undo(): void {
    const snap = this.history.undo(snapshotDoc(this.doc))
    if (snap === null) return
    this.restoreSnapshot(snap)
  }

  redo(): void {
    const snap = this.history.redo(snapshotDoc(this.doc))
    if (snap === null) return
    this.restoreSnapshot(snap)
  }

  /** 恢复快照；折叠状态属于视图态，沿用恢复前的 */
  private restoreSnapshot(snap: string): void {
    const focusIds = this.focusStack.map((node) => node.id)
    const collapsed = new Map<string, boolean>()
    this.doc.traverse((n) => collapsed.set(n.id, n.collapsed))
    this.doc = restoreDoc(snap)
    this.doc.traverse((n) => {
      const c = collapsed.get(n.id)
      if (c !== undefined) n.collapsed = c
    })
    this.reconcileSelection()
    const restoredFocus = [...focusIds]
      .reverse()
      .map((id) => this.doc.find(id))
      .find((node): node is MindmapNode => node !== null)
    this.focusStack = restoredFocus ? this.focusPathTo(restoredFocus) : []
    this.syncSourceFromDocument()
    this.emit('change', this.getMarkdown())
    this.emit('focusChange', this.focusTitles())
  }

  // ---------- 编辑操作 ----------

  select(id: string | null): void {
    this.selectMany(id ? [id] : [], id, id)
  }

  /** 替换节点选择集合；primaryId 作为后续键盘操作的锚点。 */
  selectMany(ids: Iterable<string>, primaryId: string | null = null, anchorId: string | null = null): void {
    const next = new Set<string>()
    for (const id of ids) {
      if (this.doc.find(id)) next.add(id)
    }
    let primary = primaryId && next.has(primaryId) ? primaryId : null
    if (!primary && next.size > 0) primary = [...next][next.size - 1] ?? null
    let anchor = anchorId && next.has(anchorId) ? anchorId : null
    if (!anchor && next.size > 0) anchor = [...next][0] ?? null
    if (
      this.selectedId === primary &&
      this.selectionAnchorId === anchor &&
      setsEqual(this.selectionIdsState, next)
    ) return
    this.selectionIdsState = next
    this.selectedId = primary
    this.selectionAnchorId = anchor
    this.emit('selectionChange', primary)
  }

  updateNodeRaw(id: string, raw: string): void {
    const node = this.doc.find(id)
    if (!node || node.content.raw === raw.trim()) return
    this.mutate(() => this.doc.updateRaw(node, raw))
  }

  /** 更新可见文案而不是 Markdown raw，用于链接 label / 富文本节点的直接编辑。 */
  updateNodeDisplayText(id: string, text: string): void {
    const node = this.doc.find(id)
    if (!node || node.content.text === text.trim()) return
    this.mutate(() => this.doc.updateDisplayText(node, text))
  }

  toggleNodeInlineFormat(id: string, start: number, end: number, format: InlineFormat): void {
    const node = this.doc.find(id)
    if (!node || node.content.image || start === end) return
    this.mutate(() => this.doc.toggleInlineFormat(node, start, end, format))
  }

  inlineFormatActive(id: string, start: number, end: number, format: InlineFormat): boolean {
    const node = this.doc.find(id)
    return !!node && this.doc.inlineFormatActive(node, start, end, format)
  }

  formatSelectedNodes(format: InlineFormat): void {
    const nodes = this.selectedNodes.filter((node) =>
      node !== this.doc.root && node !== this.focusRootNode && !node.content.image && node.content.text.length > 0,
    )
    if (nodes.length === 0) return
    const enabled = !nodes.every((node) => this.doc.inlineFormatActive(node, 0, node.content.text.length, format))
    this.mutate(() => nodes.forEach((node) => this.doc.setInlineFormat(node, format, enabled)))
  }

  clearNodeInlineFormats(id: string, start: number, end: number): void {
    const node = this.doc.find(id)
    if (!node || node.content.image || start === end) return
    this.mutate(() => this.doc.clearInlineFormats(node, start, end))
  }

  clearSelectedNodeFormats(): void {
    const nodes = this.selectedNodes.filter((node) =>
      node !== this.doc.root && node !== this.focusRootNode && !node.content.image && node.content.text.length > 0,
    )
    if (nodes.length === 0) return
    this.mutate(() => nodes.forEach((node) => this.doc.clearInlineFormats(node)))
  }

  setNodeInlineLink(id: string, start: number, end: number, url: string | null): void {
    const node = this.doc.find(id)
    if (!node || node.content.image || start === end) return
    this.mutate(() => this.doc.setInlineLink(node, start, end, url))
  }

  updateNodeInlineLink(id: string, rawStart: number, rawEnd: number, url: string | null): void {
    const node = this.doc.find(id)
    if (!node || node.content.image) return
    this.mutate(() => this.doc.updateInlineLink(node, rawStart, rawEnd, url))
  }

  toggleChecked(id: string): void {
    const node = this.doc.find(id)
    if (!node || node === this.doc.root) return
    this.mutate(() => this.doc.toggleChecked(node))
  }

  toggleTask(id: string): void {
    const node = this.doc.find(id)
    if (!node || node === this.doc.root) return
    this.mutate(() => this.doc.toggleTask(node))
  }

  toggleTaskSelectedNodes(): void {
    const nodes = this.selectedNodes.filter((node) => node !== this.doc.root && node !== this.focusRootNode)
    if (nodes.length === 0) return
    const primary = this.selectedNode && nodes.includes(this.selectedNode) ? this.selectedNode : nodes[nodes.length - 1]
    const next: boolean | null = primary.content.checked === null ? false : null
    this.mutate(() => nodes.forEach((node) => (node.content.checked = next)))
  }

  toggleCheckedSelectedNodes(): void {
    const nodes = this.selectedNodes.filter((node) => node.content.checked !== null)
    if (nodes.length === 0) return
    const selected = this.selectedNode
    const primary = selected && selected.content.checked !== null ? selected : nodes[nodes.length - 1]
    const next = primary.content.checked !== true
    this.mutate(() => nodes.forEach((node) => (node.content.checked = next)))
  }

  setImageWidth(id: string, width: number | null): void {
    const node = this.doc.find(id)
    if (node) this.mutate(() => this.doc.setImageWidth(node, width))
  }

  /** 折叠是视图态：不进历史。位置补偿由视图层负责 */
  toggleCollapse(id: string): void {
    const node = this.doc.find(id)
    if (!node || node.children.length === 0) return
    this.doc.toggleCollapse(node)
    this.emit('collapseChange', null)
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const node = this.doc.find(id)
    if (!node || node.children.length === 0 || node.collapsed === collapsed) return
    this.doc.toggleCollapse(node, collapsed)
    this.emit('collapseChange', null)
  }

  toggleCollapseSiblings(id: string): void {
    const node = this.doc.find(id)
    if (!node?.parent) return
    const siblings = node.parent.children.filter((item) => item.children.length > 0)
    if (siblings.length === 0) return
    // 叶子节点也能从右键菜单触发；不能依赖当前节点自身的 collapsed。
    // 只要同级仍有展开分支就统一收起，已经全部收起时再统一展开。
    const collapsed = siblings.some((item) => !item.collapsed)
    siblings.forEach((item) => this.doc.toggleCollapse(item, collapsed))
    this.emit('collapseChange', null)
  }

  toggleCollapseAll(): void {
    const root = this.focusRootNode
    let changed = false
    if (root.collapsed) {
      this.doc.toggleCollapse(root, false)
      changed = true
    }
    const nodes: MindmapNode[] = []
    this.doc.traverse((node) => {
      if (node !== root && node.children.length > 0) nodes.push(node)
    }, { from: root })
    if (nodes.length === 0) {
      if (changed) this.emit('collapseChange', null)
      return
    }
    const collapsed = nodes.some((node) => !node.collapsed)
    nodes.forEach((node) => {
      if (node.collapsed !== collapsed) {
        this.doc.toggleCollapse(node, collapsed)
        changed = true
      }
    })
    if (changed) this.emit('collapseChange', null)
  }

  /**
   * 按当前聚焦主题设置可见层级。level=1 表示显示当前主题的直接子主题，
   * 因而把相对深度 >= 1 的所有可折叠主题收起；进入子主题后深度从该主题重新计算。
   */
  setCollapseLevel(level: 1 | 2 | 3): void {
    const root = this.focusRootNode
    let changed = false
    // 当前相对根本身必须展开，否则即使设置了 1/2/3 级，内容仍不可见。
    if (root.collapsed) {
      this.doc.toggleCollapse(root, false)
      changed = true
    }
    const visit = (node: MindmapNode, depth: number) => {
      if (node.children.length > 0) {
        const collapsed = depth >= level
        if (node !== root && node.collapsed !== collapsed) {
          this.doc.toggleCollapse(node, collapsed)
          changed = true
        }
        for (const child of node.children) visit(child, depth + 1)
      }
    }
    visit(root, 0)
    if (changed) this.emit('collapseChange', null)
  }

  insertChildOf(id: string, index?: number): MindmapNode | null {
    const parent = this.doc.find(id)
    if (!parent) return null
    let created: MindmapNode | null = null
    this.mutate(() => {
      parent.collapsed = false
      created = this.doc.insertChild(parent, index ?? parent.children.length, '')
    })
    return created
  }

  insertSiblingOf(id: string): MindmapNode | null {
    const node = this.doc.find(id)
    if (!node) return null
    let created: MindmapNode | null = null
    this.mutate(() => {
      created = this.doc.insertAfter(node, '')
    })
    return created
  }

  /**
   * 为异步图片落盘准备一次文档变更，但不立即改 UI。
   * 调用方先写图片和 markdown，全部成功后再 commit，避免出现半完成节点。
   */
  prepareImageInsertion(anchorId: string, src: string, alt = '截图'): PreparedDocumentChange | null {
    const baseSnapshot = snapshotDoc(this.doc)
    const preparedDoc = restoreDoc(baseSnapshot)
    const anchor = preparedDoc.find(anchorId)
    if (!anchor) return null

    const safeAlt = alt.replace(/\]/g, '').trim() || '截图'
    const raw = `![${safeAlt}](${src})`
    let inserted: MindmapNode
    if (anchor !== preparedDoc.root && anchor.content.raw.trim() === '') {
      preparedDoc.updateRaw(anchor, raw)
      inserted = anchor
    } else {
      const created = preparedDoc.insertAfter(anchor, raw)
      if (!created) return null
      inserted = created
    }

    const insertedId = inserted.id
    const preparedSnapshot = snapshotDoc(preparedDoc)
    const markdown = serializeMarkdown(preparedDoc)
    let committed = false
    return {
      markdown,
      commit: () => {
        if (committed) throw new Error('该图片插入事务已经提交')
        if (snapshotDoc(this.doc) !== baseSnapshot) throw new Error('文档已变化，无法提交过期的图片插入事务')
        committed = true
        this.history.record(baseSnapshot)
        this.doc = restoreDoc(preparedSnapshot)
        this.focusStack = this.focusStack
          .map((node) => this.doc.find(node.id))
          .filter((node): node is MindmapNode => node !== null)
        this.reconcileSelection()
        this.syncSourceFromDocument()
        const result = this.doc.find(insertedId)
        if (!result) throw new Error('无法恢复已准备的图片节点')
        this.select(result.id)
        this.emit('change', this.getMarkdown())
        return result
      },
    }
  }

  /** 脑图 Shift+Tab：在当前主题与原父主题之间插入一个空的上级主题。 */
  insertParentOf(id: string): MindmapNode | null {
    const node = this.doc.find(id)
    if (!node || node === this.doc.root || node === this.focusRootNode || !node.parent) return null
    let created: MindmapNode | null = null
    this.mutate(() => {
      const oldParent = node.parent!
      const index = oldParent.children.indexOf(node)
      created = this.doc.addNode(oldParent, parseInline(''), index)
      this.doc.move(node, created, 0)
    })
    return created
  }

  /** 在指定节点之前插入同级（行首 Enter 场景） */
  insertBeforeOf(id: string): MindmapNode | null {
    const node = this.doc.find(id)
    if (!node || !node.parent || node === this.doc.root) return null
    let created: MindmapNode | null = null
    this.mutate(() => {
      const i = node.parent!.children.indexOf(node)
      created = this.doc.addNode(node.parent!, parseInline(''), i)
    })
    return created
  }

  /**
   * 事务：把多个文档操作合并为一条历史 + 一次 change 广播。
   * 供视图层实现复合操作（Enter 分裂、Backspace 合并、多行粘贴等）。
   */
  transact(fn: (doc: MindmapDocument) => void): void {
    this.mutate(() => fn(this.doc))
  }

  indentNode(id: string): void {
    const node = this.doc.find(id)
    // 预检：无可行操作时不动历史
    if (!node || !node.parent || node === this.doc.root) return
    if (node.parent.children.indexOf(node) <= 0) return
    this.mutate(() => {
      this.doc.indent(node)
    })
  }

  outdentNode(id: string): void {
    const node = this.doc.find(id)
    if (!node || !node.parent || node === this.doc.root) return
    if (node.parent === this.doc.root || !node.parent.parent) return
    this.mutate(() => {
      this.doc.outdent(node)
    })
  }

  removeNode(id: string): void {
    const node = this.doc.find(id)
    if (!node || node === this.doc.root) return
    let nextSelect: string | null = null
    this.mutate(() => {
      const pos = this.doc.remove(node)!
      const siblings = pos.parent.children
      const next = siblings[pos.index] ?? siblings[pos.index - 1] ?? pos.parent
      nextSelect = next === this.doc.root && siblings.length > 0 ? (siblings[0]?.id ?? null) : next.id
    })
    this.select(nextSelect)
  }

  /** 删除当前主题自身，并把它的直接子主题原位提升为同级。 */
  removeNodeOnly(id: string): void {
    const node = this.doc.find(id)
    const parent = node?.parent
    if (!node || !parent || node === this.doc.root || node === this.focusRootNode) return
    const index = parent.children.indexOf(node)
    if (index < 0) return
    const promotedIds = node.children.map((child) => child.id)
    this.mutate(() => {
      const promoted = [...node.children]
      parent.children.splice(index, 1, ...promoted)
      promoted.forEach((child) => (child.parent = parent))
      node.children = []
      node.parent = null
    })
    const next = promotedIds[0] ?? parent.children[index]?.id ?? parent.children[index - 1]?.id ?? parent.id
    this.select(next === this.doc.root.id ? null : next)
  }

  /** 删除当前选择中的顶层子树，多个节点合并为一条历史。 */
  removeSelectedNodes(): void {
    const roots = this.selectedTopLevelNodes()
    this.removeNodeRoots(roots)
  }

  /** 删除调用时捕获的一组节点；异步剪切完成后不会误删后来切换到的新选择。 */
  removeNodesByIds(ids: Iterable<string>): void {
    const roots = this.topLevelNodesFromIds(new Set(ids))
    this.removeNodeRoots(roots)
  }

  private removeNodeRoots(roots: MindmapNode[]): void {
    if (roots.length === 0) return
    if (roots.length === 1) {
      this.removeNode(roots[0].id)
      return
    }

    const visible: MindmapNode[] = []
    this.doc.traverse((n) => visible.push(n), { visibleOnly: true, from: this.focusRootNode })
    const selected = new Set(roots.map((n) => n.id))
    const firstIndex = visible.findIndex((n) => selected.has(n.id))
    const fallback =
      [...visible.slice(0, Math.max(0, firstIndex))].reverse().find((n) => !this.isWithinSelectedRoots(n, roots)) ??
      visible.slice(Math.max(0, firstIndex)).find((n) => !this.isWithinSelectedRoots(n, roots)) ??
      this.focusRootNode

    this.mutate(() => {
      for (const node of roots) this.doc.remove(node)
    })
    this.select(fallback === this.doc.root && fallback !== this.focusRootNode ? null : fallback.id)
  }

  /** 多选缩进：同父级的连续顶层选择整体成为前一兄弟的子节点。 */
  indentSelectedNodes(): void {
    const roots = this.selectedTopLevelNodes()
    if (roots.length === 0) return
    if (roots.length === 1) {
      this.indentNode(roots[0].id)
      return
    }
    const parent = roots[0].parent
    if (!parent || roots.some((n) => n.parent !== parent)) return
    const indices = roots.map((n) => parent.children.indexOf(n)).sort((a, b) => a - b)
    if (indices[0] <= 0 || indices.some((value, i) => i > 0 && value !== indices[i - 1] + 1)) return
    const newParent = parent.children[indices[0] - 1]
    if (this.selectionIdsState.has(newParent.id)) return
    this.mutate(() => {
      newParent.collapsed = false
      for (const node of roots) this.doc.move(node, newParent, newParent.children.length)
    })
  }

  /** 多选提升：同父级的连续顶层选择整体移动到父节点之后。 */
  outdentSelectedNodes(): void {
    const roots = this.selectedTopLevelNodes()
    if (roots.length === 0) return
    if (roots.length === 1) {
      this.outdentNode(roots[0].id)
      return
    }
    const parent = roots[0].parent
    const grand = parent?.parent
    if (!parent || !grand || parent === this.doc.root || roots.some((n) => n.parent !== parent)) return
    const indices = roots.map((n) => parent.children.indexOf(n)).sort((a, b) => a - b)
    if (indices.some((value, i) => i > 0 && value !== indices[i - 1] + 1)) return
    this.mutate(() => {
      let index = grand.children.indexOf(parent) + 1
      for (const node of roots) this.doc.move(node, grand, index++)
    })
  }

  /** 将同父级连续选择整体向上/向下移动一个位置。 */
  moveSelectedNodes(direction: -1 | 1): void {
    const roots = this.selectedTopLevelNodes()
    if (roots.length === 0) return
    const parent = roots[0].parent
    if (!parent || roots.some((n) => n.parent !== parent)) return
    const indices = roots.map((n) => parent.children.indexOf(n)).sort((a, b) => a - b)
    if (indices.some((value, i) => i > 0 && value !== indices[i - 1] + 1)) return
    const first = indices[0]
    const last = indices[indices.length - 1]
    if ((direction < 0 && first === 0) || (direction > 0 && last === parent.children.length - 1)) return
    this.mutate(() => {
      const group = parent.children.splice(first, roots.length)
      const insertAt = direction < 0 ? first - 1 : first + 1
      parent.children.splice(insertAt, 0, ...group)
    })
  }

  /** 创建当前顶层选择的副本，并将副本放到选择之后。 */
  duplicateSelectedNodes(): void {
    const roots = this.selectedTopLevelNodes()
    if (roots.length === 0) return
    const parent = roots[0].parent
    if (!parent || roots.some((n) => n.parent !== parent)) return
    const indices = roots.map((n) => parent.children.indexOf(n)).sort((a, b) => a - b)
    if (indices.some((value, i) => i > 0 && value !== indices[i - 1] + 1)) return
    const copies = roots.map((node) => cloneSubtree(node))
    this.mutate(() => {
      const insertAt = indices[indices.length - 1] + 1
      copies.forEach((copy) => (copy.parent = parent))
      parent.children.splice(insertAt, 0, ...copies)
    })
    this.selectMany(copies.map((node) => node.id), copies[copies.length - 1]?.id ?? null, copies[0]?.id ?? null)
  }

  moveNode(id: string, newParentId: string, index: number): boolean {
    const node = this.doc.find(id)
    const parent = this.doc.find(newParentId)
    if (!node || !parent) return false
    // 预检：不合法移动不动历史
    if (node === this.doc.root || node === parent || isAncestor(node, parent)) return false
    this.mutate(() => {
      parent.collapsed = false
      this.doc.move(node, parent, index)
    })
    return true
  }

  // ---------- 聚焦 ----------

  focusNode(id: string): void {
    const node = this.doc.find(id)
    if (!node) return
    const nextPath = node === this.doc.root ? [] : this.focusPathTo(node)
    const pathChanged = nextPath.length !== this.focusStack.length
      || nextPath.some((item, index) => item.id !== this.focusStack[index]?.id)
    if (node.collapsed) {
      node.collapsed = false
      this.emit('collapseChange', null)
    }
    if (!pathChanged) return
    this.focusStack = nextPath
    this.emit('focusChange', this.focusTitles())
  }

  /** 从面包屑等导航入口切换聚焦根，并把选择收敛到新的可见根。 */
  switchFocusNode(id: string): void {
    const node = this.doc.find(id)
    if (!node) return
    this.focusNode(id)
    this.select(node === this.doc.root ? null : node.id)
  }

  focusSelected(): void {
    const node = this.selectedNode
    if (!node) return
    this.focusNode(node.id)
  }

  /** 退到聚焦路径的第 index 层；index = 0 表示完全退出 */
  exitFocusTo(index: number): void {
    const nextLength = Math.max(0, Math.min(Math.trunc(index), this.focusStack.length))
    if (nextLength === this.focusStack.length) return
    this.focusStack.length = nextLength
    this.emit('focusChange', this.focusTitles())
  }

  /** 返回从文档根之下到目标节点的真实祖先链（不包含文档根）。 */
  private focusPathTo(node: MindmapNode): MindmapNode[] {
    const path: MindmapNode[] = []
    let current: MindmapNode | null = node
    while (current && current !== this.doc.root) {
      path.push(current)
      current = current.parent
    }
    return current === this.doc.root ? path.reverse() : []
  }

  private focusTitles(): string[] {
    return this.focusStack.map((n) => n.content.text)
  }

  // ---------- 搜索 ----------

  search(query: string): MindmapNode[] {
    return this.doc.search(query)
  }

  setMatchHighlight(ids: Set<string>): void {
    if (this.matchIds.size === ids.size) {
      let same = true
      for (const id of ids) {
        if (!this.matchIds.has(id)) {
          same = false
          break
        }
      }
      if (same) return
    }
    this.matchIds = ids
    this.emit('matchChange', null)
  }

  /** 展开节点的全部祖先折叠（搜索/大纲定位用） */
  expandAncestors(id: string): void {
    const node = this.doc.find(id)
    if (!node) return
    let p = node.parent
    let changed = false
    while (p) {
      if (p.collapsed) {
        p.collapsed = false
        changed = true
      }
      p = p.parent
    }
    if (changed) this.emit('collapseChange', null)
  }

  // ---------- 内部 ----------

  private cleanFileName(): string {
    return this.fileName.replace(/\.(tn-mindmap\.)?md$/i, '')
  }

  private mutate(fn: () => void): void {
    this.history.record(snapshotDoc(this.doc))
    fn()
    this.syncSourceFromDocument()
    this.emit('change', this.getMarkdown())
  }

  private syncSourceFromDocument(): void {
    this.sourceMarkdown = serializeMarkdown(this.doc)
    if (this.diagnosticsState.length > 0) {
      this.diagnosticsState = []
      this.emit('validityChange', this.diagnostics)
    }
  }

  private selectedTopLevelNodes(): MindmapNode[] {
    return this.topLevelNodesFromIds(this.selectionIdsState)
  }

  private topLevelNodesFromIds(ids: ReadonlySet<string>): MindmapNode[] {
    const nodes: MindmapNode[] = []
    this.doc.traverse((node) => {
      if (ids.has(node.id)) nodes.push(node)
    })
    return nodes.filter((node) => {
      let parent = node.parent
      while (parent) {
        if (ids.has(parent.id)) return false
        parent = parent.parent
      }
      return node !== this.doc.root && node !== this.focusRootNode
    })
  }

  private isWithinSelectedRoots(node: MindmapNode, roots: MindmapNode[]): boolean {
    return roots.some((root) => node === root || isAncestor(root, node))
  }

  private reconcileSelection(): void {
    const next = new Set<string>()
    for (const id of this.selectionIdsState) {
      if (this.doc.find(id)) next.add(id)
    }
    this.selectionIdsState = next
    if (this.selectedId && !next.has(this.selectedId)) {
      const ids = [...next]
      this.selectedId = ids[ids.length - 1] ?? null
    }
    if (this.selectionAnchorId && !next.has(this.selectionAnchorId)) {
      this.selectionAnchorId = [...next][0] ?? null
    }
  }

  destroy(): void {
    this.listeners.clear()
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}
