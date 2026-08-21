import { CanvasEditor } from './canvasEditor'
import type { CanvasEditorEvents } from './canvasEditor'
import type { TextMeasurer } from './layout/treeLayout'
import type { CanvasThemeMode } from './render/canvasRenderer'
import type { MindmapSession } from './session'

export interface CanvasViewerOptions {
  theme?: CanvasThemeMode
  measurer?: TextMeasurer
  onRequestSearch?: CanvasEditorEvents['onRequestSearch']
  onImagePreview?: CanvasEditorEvents['onImagePreview']
  resolveImageSrc?: CanvasEditorEvents['resolveImageSrc']
}

/**
 * Supported read-only Canvas controller for documentation sites and previews.
 * It intentionally exposes viewport controls only; document mutation stays behind CanvasEditor.
 */
export class CanvasViewer {
  private readonly controller: CanvasEditor

  constructor(
    private readonly container: HTMLElement,
    session: MindmapSession,
    options: CanvasViewerOptions = {},
  ) {
    this.container.classList.add('mm-viewer')
    this.controller = new CanvasEditor(
      container,
      session,
      {
        onRequestSearch: options.onRequestSearch,
        onImagePreview: options.onImagePreview,
        resolveImageSrc: options.resolveImageSrc,
      },
      options.measurer,
      { readOnly: true, theme: options.theme },
    )
  }

  zoomToFit(): void {
    this.controller.zoomToFit()
  }

  zoomBy(factor: number): void {
    this.controller.zoomBy(factor)
  }

  getScale(): number {
    return this.controller.getScale()
  }

  centerOnNode(id: string, select = false): void {
    this.controller.centerOnNode(id, select)
  }

  setTheme(theme: CanvasThemeMode): void {
    this.controller.setTheme(theme)
  }

  destroy(): void {
    this.controller.destroy()
    this.container.classList.remove('mm-viewer')
  }
}
