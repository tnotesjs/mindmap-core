export interface RichSelectionOffsets {
  start: number
  end: number
  anchor: number
  focus: number
  direction: 'forward' | 'backward'
}

export interface RichInlineEditorElement extends HTMLDivElement {
  value: string
  readonly rawValue: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly isDirty: boolean
  readonly isComposing: boolean
  setSelectionRange(start: number, end: number): void
  markCommitted(): void
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ index: number; segment: string }>
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter

const GraphemeSegmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter

function nodeTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLBRElement) return 0
  let total = 0
  node.childNodes.forEach((child) => (total += nodeTextLength(child)))
  return total
}

export function domPointToPlainOffset(root: HTMLElement, node: Node, nodeOffset: number): number {
  if (node !== root && !root.contains(node)) return 0
  let total = 0
  const visit = (current: Node): boolean => {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        total += Math.max(0, Math.min(current.textContent?.length ?? 0, nodeOffset))
      } else {
        const children = [...current.childNodes]
        for (let index = 0; index < Math.min(children.length, nodeOffset); index++) {
          total += nodeTextLength(children[index])
        }
      }
      return true
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += current.textContent?.length ?? 0
      return false
    }
    for (const child of current.childNodes) {
      if (visit(child)) return true
    }
    return false
  }
  visit(root)
  return total
}

function plainOffsetToDomPoint(
  root: HTMLElement,
  offset: number,
  affinity: 'backward' | 'forward' = 'backward',
): { node: Node; offset: number } {
  const target = Math.max(0, Math.min(root.textContent?.length ?? 0, offset))
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let previous: Text | null = null
  let current = walker.nextNode() as Text | null
  while (current) {
    const length = current.data.length
    const end = consumed + length
    if (target < end || (target === end && affinity === 'backward')) {
      return { node: current, offset: target - consumed }
    }
    if (target === consumed && affinity === 'forward') return { node: current, offset: 0 }
    consumed = end
    previous = current
    current = walker.nextNode() as Text | null
  }
  if (previous) return { node: previous, offset: previous.data.length }
  return { node: root, offset: root.childNodes.length }
}

export function richSelectionOffsets(root: HTMLElement): RichSelectionOffsets | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return null
  if (
    (selection.anchorNode !== root && !root.contains(selection.anchorNode)) ||
    (selection.focusNode !== root && !root.contains(selection.focusNode))
  ) return null
  const anchor = domPointToPlainOffset(root, selection.anchorNode, selection.anchorOffset)
  const focus = domPointToPlainOffset(root, selection.focusNode, selection.focusOffset)
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    anchor,
    focus,
    direction: anchor <= focus ? 'forward' : 'backward',
  }
}

export function setRichSelection(
  root: HTMLElement,
  start: number,
  end = start,
  direction: 'forward' | 'backward' = 'forward',
): void {
  const selection = window.getSelection()
  if (!selection) return
  const from = plainOffsetToDomPoint(root, Math.min(start, end), 'forward')
  const to = plainOffsetToDomPoint(root, Math.max(start, end), 'backward')
  selection.removeAllRanges()
  if (direction === 'backward' && typeof selection.setBaseAndExtent === 'function') {
    selection.setBaseAndExtent(to.node, to.offset, from.node, from.offset)
    return
  }
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  selection.addRange(range)
}

export function richSelectionRect(root: HTMLElement): DOMRect {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (range && (range.commonAncestorContainer === root || root.contains(range.commonAncestorContainer))) {
    const rect = range.getBoundingClientRect?.()
    if (rect && (rect.width > 0 || rect.height > 0)) return rect
  }
  return root.getBoundingClientRect()
}

export function caretOffsetFromPoint(root: HTMLElement, x: number, y: number): number {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = doc.caretPositionFromPoint?.(x, y)
  if (position && (position.offsetNode === root || root.contains(position.offsetNode))) {
    return domPointToPlainOffset(root, position.offsetNode, position.offset)
  }
  const range = doc.caretRangeFromPoint?.(x, y)
  if (range && (range.startContainer === root || root.contains(range.startContainer))) {
    return domPointToPlainOffset(root, range.startContainer, range.startOffset)
  }
  return root.textContent?.length ?? 0
}

export function previousGraphemeOffset(text: string, offset: number): number {
  const target = Math.max(0, Math.min(text.length, offset))
  if (target === 0) return 0
  if (!GraphemeSegmenter) return target - 1
  const segments = [...new GraphemeSegmenter(undefined, { granularity: 'grapheme' }).segment(text)]
  let previous = 0
  for (const segment of segments) {
    if (segment.index >= target) break
    previous = segment.index
  }
  return previous
}

export function nextGraphemeOffset(text: string, offset: number): number {
  const target = Math.max(0, Math.min(text.length, offset))
  if (target >= text.length) return text.length
  if (!GraphemeSegmenter) return target + 1
  for (const segment of new GraphemeSegmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (segment.index > target) return segment.index
  }
  return text.length
}
