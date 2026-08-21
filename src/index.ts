/**
 * @tnotesjs/mindmap-core public API.
 * Consumers should import from this entry instead of internal source paths.
 */

export { MindmapSession } from './session'
export type { PreparedDocumentChange, SessionEvents, SessionOptions } from './session'
export { CanvasEditor, createCanvasMeasurer } from './canvasEditor'
export type { CanvasContextRequest, CanvasEditorEvents, CanvasEditorOptions, CanvasLinkHover } from './canvasEditor'
export { CanvasViewer } from './canvasViewer'
export type { CanvasViewerOptions } from './canvasViewer'
export type { CanvasThemeMode } from './render/canvasRenderer'
export { cloneSubtree, MindmapDocument, resetNodeIdCounter, restoreDoc, snapshotDoc, visibleChildren } from './model/document'
export type { MindmapNode } from './model/document'
export {
  clearInlineFormats,
  inlineFormatActive,
  inlineAttributesAt,
  parseInlineSegments,
  replaceInlineDisplayText,
  replaceInlineRange,
  serializeInlineSegments,
  setInlineFormat,
  setInlineLink,
  stripInline,
  toggleInlineFormat,
  updateInlineLink,
} from './model/inline'
export type { InlineAttributes, InlineFormat, InlineLink, InlineMarks, InlineSegment, NodeContent } from './model/inline'
export { parseMarkdown } from './markdown/parser'
export type { MarkdownDiagnostic, MarkdownDiagnosticCode, ParseResult } from './markdown/parser'
export { serializeMarkdown, serializeSubtree } from './markdown/serializer'
export { wrapTextLines } from './layout/treeLayout'
export type { TextMeasurer } from './layout/treeLayout'
export {
  caretOffsetFromPoint,
  domPointToPlainOffset,
  nextGraphemeOffset,
  previousGraphemeOffset,
  richSelectionOffsets,
  richSelectionRect,
  setRichSelection,
} from './dom/richInlineDom'
export type { RichInlineEditorElement, RichSelectionOffsets } from './dom/richInlineDom'
