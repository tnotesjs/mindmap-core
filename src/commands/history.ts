/**
 * 撤销/重做历史：快照式命令栈。
 * 每次变更前压入当前文档快照；undo 返回上一份快照并把当前快照压入 redo 栈。
 */

export class History {
  private past: string[] = []
  private future: string[] = []

  constructor(private readonly limit = 100) {}

  /** 变更前调用，记录当前快照 */
  record(snapshot: string): void {
    this.past.push(snapshot)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: string): string | null {
    const prev = this.past.pop()
    if (prev === undefined) return null
    this.future.push(current)
    return prev
  }

  redo(current: string): string | null {
    const next = this.future.pop()
    if (next === undefined) return null
    this.past.push(current)
    return next
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  clear(): void {
    this.past = []
    this.future = []
  }
}
