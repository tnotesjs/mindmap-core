# @tnotesjs/mindmap-core

Markdown-first mind map engine shared by the TNotesJS Web editor, VS Code extension, and read-only renderers.

## Install

```bash
pnpm add @tnotesjs/mindmap-core
```

## Usage

```ts
import {
  MindmapSession,
  parseMarkdown,
  serializeMarkdown,
} from '@tnotesjs/mindmap-core'

const result = parseMarkdown('# Notes\n\n- Topic')
if (result.ok) {
  const session = new MindmapSession({
    markdown: '# Notes\n\n- Topic',
    fileName: 'notes.tn-mindmap.md',
  })
  console.log(serializeMarkdown(session.document))
}
```

The package contains no Vue dependency. It exposes the Markdown parser and serializer, document model, history/session commands, inline formatting model, tree layout, Canvas renderer/editor, and DOM selection helpers used by rich-text adapters.

## File format

A valid `*.tn-mindmap.md` document contains exactly one H1 root. Content after the H1 is an unordered-list tree. Invalid source is preserved for repair instead of being normalized destructively.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## License

MIT
