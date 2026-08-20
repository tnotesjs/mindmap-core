import { beforeEach, describe, expect, it } from 'vitest'
import { resetNodeIdCounter, snapshotDoc } from '../model/document'
import { parseMarkdown } from './parser'
import { serializeMarkdown } from './serializer'

beforeEach(() => resetNodeIdCounter())

const SAMPLE = `# 读书笔记：《原则》

- 生活原则
  - 拥抱现实，应对现实
  - 五步流程实现人生目标
    - 明确目标
    - 识别问题，不容忍问题
- 工作原则
  - [桥水官网](https://www.bridgewater.com)
- 我的实践
  - [ ] 每周复盘一次决策
  - [x] 建立问题记录习惯
  - 参考资料
    - ![原则思维导图|300](https://example.com/principles-map.png)
    - ![达里奥照片](https://example.com/dalio.jpg)
`

describe('serializeMarkdown', () => {
  it('序列化输出 H1 + 2 空格缩进的无序列表', () => {
    const { doc } = parseMarkdown(SAMPLE)
    expect(serializeMarkdown(doc)).toBe(SAMPLE)
  })

  it('宽容输入（4 空格/Tab）回写后统一为 2 空格', () => {
    const { doc } = parseMarkdown('# T\n\n- a\n\t- b\n        - c\n')
    expect(serializeMarkdown(doc)).toBe('# T\n\n- a\n  - b\n    - c\n')
  })

  it('round-trip：解析 → 序列化 → 再解析，树结构不变', () => {
    const first = parseMarkdown(SAMPLE)
    const second = parseMarkdown(serializeMarkdown(first.doc))
    // 第二次解析会重新分配 id，比较时忽略 id
    const stripIds = (json: string) => json.replace(/"id":"n\d+"/g, '"id":""')
    expect(stripIds(snapshotDoc(second.doc))).toBe(stripIds(snapshotDoc(first.doc)))
  })

  it('「文件即脑图」：非脑图内容在回写时被丢弃', () => {
    const md = `---\ntitle: t\n---\n\n# 脑图\n\n- a\n\n## 附录\n\n一些说明文字\n`
    const { doc } = parseMarkdown(md)
    expect(serializeMarkdown(doc)).toBe('# 脑图\n\n- a\n')
  })

  it('空脑图只输出 H1', () => {
    const { doc } = parseMarkdown('', '新建脑图')
    expect(serializeMarkdown(doc)).toBe('# 新建脑图\n')
  })
})
