import { beforeEach, describe, expect, it } from 'vitest'
import { resetNodeIdCounter } from '../model/document'
import { parseMarkdown } from './parser'

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

describe('parseMarkdown 标准形态', () => {
  it('H1 作为根节点', () => {
    const { doc } = parseMarkdown(SAMPLE)
    expect(doc.root.content.text).toBe('读书笔记：《原则》')
  })

  it('H1 根主题保留行内语义并以纯文案参与布局和搜索', () => {
    const { doc, valid } = parseMarkdown('# **粗体**与<u>下划线</u>\n\n- child\n')
    expect(valid).toBe(true)
    expect(doc.root.content.raw).toBe('**粗体**与<u>下划线</u>')
    expect(doc.root.content.text).toBe('粗体与下划线')
  })

  it('无序列表解析为节点树，2 空格缩进为一级', () => {
    const { doc } = parseMarkdown(SAMPLE)
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['生活原则', '工作原则', '我的实践'])
    const life = doc.root.children[0]
    expect(life.children.map((n) => n.content.text)).toEqual(['拥抱现实，应对现实', '五步流程实现人生目标'])
    expect(life.children[1].children.map((n) => n.content.text)).toEqual(['明确目标', '识别问题，不容忍问题'])
    expect(life.children[1].children[0].parent).toBe(life.children[1])
  })

  it('链接节点解析出 url', () => {
    const { doc } = parseMarkdown(SAMPLE)
    const link = doc.root.children[1].children[0]
    expect(link.content.text).toBe('桥水官网')
    expect(link.content.link).toBe('https://www.bridgewater.com')
  })

  it('任务节点解析出勾选状态', () => {
    const { doc } = parseMarkdown(SAMPLE)
    const [todo, done] = doc.root.children[2].children
    expect(todo.content.checked).toBe(false)
    expect(todo.content.text).toBe('每周复盘一次决策')
    expect(done.content.checked).toBe(true)
    expect(doc.root.children[0].content.checked).toBeNull()
  })

  it('图片节点解析出 src/alt/宽度（Obsidian 风格 |宽度）', () => {
    const { doc } = parseMarkdown(SAMPLE)
    const [withWidth, plain] = doc.root.children[2].children[2].children
    expect(withWidth.content.image).toEqual({
      src: 'https://example.com/principles-map.png',
      alt: '原则思维导图',
      width: 300,
    })
    expect(withWidth.content.text).toBe('原则思维导图')
    expect(plain.content.image).toEqual({
      src: 'https://example.com/dalio.jpg',
      alt: '达里奥照片',
      width: null,
    })
  })

  it('纯净脑图文件无额外内容标记', () => {
    const { valid, diagnostics, hasExtraContent } = parseMarkdown(SAMPLE)
    expect(valid).toBe(true)
    expect(diagnostics).toEqual([])
    expect(hasExtraContent).toBe(false)
  })
})

describe('parseMarkdown 宽容缩进', () => {
  it('4 空格缩进与 2 空格解析结果一致', () => {
    const two = parseMarkdown('# T\n\n- a\n  - b\n    - c\n')
    const four = parseMarkdown('# T\n\n- a\n    - b\n        - c\n')
    expect(four.doc.root.children[0].children[0].content.text).toBe('b')
    expect(four.doc.root.children[0].children[0].children[0].content.text).toBe('c')
    expect(two.doc.root.children[0].children[0].children[0].content.text).toBe('c')
  })

  it('Tab 缩进可正确读出层级', () => {
    const { doc } = parseMarkdown('# T\n\n- a\n\t- b\n\t\t- c\n')
    expect(doc.root.children[0].children[0].content.text).toBe('b')
    expect(doc.root.children[0].children[0].children[0].content.text).toBe('c')
  })

  it('支持 * 作为列表标记', () => {
    const { doc } = parseMarkdown('# T\n\n* a\n  * b\n')
    expect(doc.root.children[0].children[0].content.text).toBe('b')
  })
})

describe('parseMarkdown 边界情况', () => {
  it('无 H1 非法：返回明确诊断，且保留虚拟树仅供调用方兜底', () => {
    const { doc, valid, diagnostics, hasExtraContent } = parseMarkdown('- a\n- b\n- c\n', '旅行计划')
    expect(doc.root.content.text).toBe('旅行计划')
    expect(doc.root.children).toEqual([])
    expect(valid).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'missing-h1', line: 1, column: 1 }),
    ])
    expect(hasExtraContent).toBe(true)
  })

  it('空文件非法：缺少 H1', () => {
    const { doc, valid, diagnostics, hasExtraContent } = parseMarkdown('', '新建脑图')
    expect(doc.root.content.text).toBe('新建脑图')
    expect(doc.root.children).toEqual([])
    expect(valid).toBe(false)
    expect(diagnostics[0]).toMatchObject({ code: 'missing-h1', line: 1, column: 1 })
    expect(hasExtraContent).toBe(true)
  })

  it('frontmatter / 附录段落 / 表格等非脑图内容被忽略并标记', () => {
    const md = `---\ntitle: t\n---\n\n# 脑图\n\n- a\n\n## 附录\n\n| 列 | 值 |\n| -- | -- |\n| 1  | 2  |\n`
    const { doc, valid, diagnostics, hasExtraContent } = parseMarkdown(md)
    expect(doc.root.content.text).toBe('脑图')
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['a'])
    expect(valid).toBe(false)
    expect(diagnostics.map((item) => item.code)).toEqual([
      'content-before-h1',
      'content-before-h1',
      'content-before-h1',
      'extra-content',
      'extra-content',
      'extra-content',
      'extra-content',
    ])
    expect(hasExtraContent).toBe(true)
  })

  it('列表项附属的缩进段落非法，后续列表项仍可用于诊断预览树', () => {
    const md = '# T\n\n- a\n  这是一段附属说明\n- b\n'
    const { doc, valid, diagnostics, hasExtraContent } = parseMarkdown(md)
    expect(doc.root.children.map((n) => n.content.text)).toEqual(['a', 'b'])
    expect(valid).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'extra-content', line: 4, column: 3 }),
    ])
    expect(hasExtraContent).toBe(true)
  })

  it('行内格式保留源码，展示为纯文本', () => {
    const { doc } = parseMarkdown('# T\n\n- **加粗** 和 `代码`\n')
    const node = doc.root.children[0]
    expect(node.content.raw).toBe('**加粗** 和 `代码`')
    expect(node.content.text).toBe('加粗 和 代码')
  })

  it('第二个 H1 不改变根，且标记为额外内容', () => {
    const { doc, valid, diagnostics, hasExtraContent } = parseMarkdown('# 一\n\n- a\n\n# 二\n')
    expect(doc.root.content.text).toBe('一')
    expect(valid).toBe(false)
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'multiple-h1', line: 5, column: 1 }),
    ])
    expect(hasExtraContent).toBe(true)
  })

  it('H1 后的普通段落非法，并提供 1-based 行列', () => {
    const result = parseMarkdown('# T\n\n- a\n\n  paragraph\n')
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual([
      {
        code: 'extra-content',
        line: 5,
        column: 3,
        message: '一级标题后只允许空行和无序列表项',
      },
    ])
  })

  it('H1 前允许空行，但不允许任何非空内容', () => {
    expect(parseMarkdown('\n\n# T\n').valid).toBe(true)
    const result = parseMarkdown('intro\n\n# T\n')
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'content-before-h1', line: 1, column: 1 })
  })

  it('空任务节点仍按任务节点解析', () => {
    const { doc, valid } = parseMarkdown('# T\n\n- [ ] \n')
    expect(valid).toBe(true)
    expect(doc.root.children[0].content.checked).toBe(false)
    expect(doc.root.children[0].content.text).toBe('')
  })
})
