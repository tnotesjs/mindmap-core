import { describe, expect, it } from 'vitest'
import {
  clearInlineFormats,
  inlineFormatActive,
  parseInline,
  parseInlineSegments,
  replaceInlineDisplayText,
  replaceInlineRange,
  setInlineFormat,
  setInlineLink,
  stripInline,
  toggleInlineFormat,
  updateInlineLink,
} from './inline'

describe('Markdown 行内模型', () => {
  it('解析粗体、斜体、下划线、删除线、高亮、代码和链接', () => {
    const raw = '**粗体** *斜体* <u>下划线</u> ~~删除~~ ==高亮== `代码` [链接](https://example.com)'
    expect(stripInline(raw)).toBe('粗体 斜体 下划线 删除 高亮 代码 链接')
    const segments = parseInlineSegments(raw)
    expect(segments.some((segment) => segment.marks.bold && segment.text === '粗体')).toBe(true)
    expect(segments.some((segment) => segment.marks.underline && segment.text === '下划线')).toBe(true)
    expect(segments.some((segment) => segment.link?.url === 'https://example.com')).toBe(true)
  })

  it('粗体与斜体组合使用时按同一个 run 解析并可稳定往返', () => {
    const segments = parseInlineSegments('***粗斜体***')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ text: '粗斜体', marks: { bold: true, italic: true } })
    const bold = toggleInlineFormat('*组合*', 0, 2, 'bold')
    expect(bold).toBe('***组合***')
    expect(stripInline(bold)).toBe('组合')
    expect(parseInlineSegments(bold)[0].marks).toMatchObject({ bold: true, italic: true })
  })

  it('跨多种既有样式批量加粗时共享外层标记并保持语义', () => {
    const raw = '***粗斜体*** 与 ~~删除线~~'
    const bold = setInlineFormat(raw, 0, stripInline(raw).length, 'bold', true)
    expect(bold).toBe('***粗斜体* 与 ~~删除线~~**')
    expect(bold).not.toContain('*****')
    expect(stripInline(bold)).toBe('粗斜体 与 删除线')

    const segments = parseInlineSegments(bold)
    expect(segments.every((segment) => segment.marks.bold)).toBe(true)
    expect(segments.find((segment) => segment.text === '粗斜体')?.marks.italic).toBe(true)
    expect(segments.find((segment) => segment.text === '删除线')?.marks.strike).toBe(true)
  })

  it('整节点链接提供兼容 link 字段，部分链接只存在于 segments', () => {
    expect(parseInline('[桥水](https://bridgewater.com)').link).toBe('https://bridgewater.com')
    expect(parseInline('访问 [桥水](https://bridgewater.com)').link).toBeNull()
    expect(parseInline('访问 [桥水](https://bridgewater.com)').text).toBe('访问 桥水')
  })

  it('编辑链接 label 时保留 URL，删完最后一个字时移除链接', () => {
    const raw = '[桥水官网](https://bridgewater.com)'
    expect(replaceInlineDisplayText(raw, '桥水')).toBe('[桥水](https://bridgewater.com)')
    expect(replaceInlineDisplayText(raw, '')).toBe('')
  })

  it('编辑格式化文案时保留外围格式', () => {
    expect(replaceInlineDisplayText('**规划方案**', '规划新方案')).toBe('**规划新方案**')
    expect(replaceInlineDisplayText('**规划**', '规划中')).toBe('**规划中**')
  })

  it('跨格式与链接边界替换时始终生成合法 Markdown', () => {
    expect(replaceInlineRange('**ab**cd', 1, 3, 'X')).toBe('**aX**d')
    expect(replaceInlineDisplayText('**ab**cd', 'aXd')).toBe('**aX**d')
    expect(replaceInlineRange('[ab](https://example.com)cd', 1, 3, 'X')).toBe('[aX](https://example.com)d')
    expect(stripInline(replaceInlineRange('**ab** *cd*', 1, 4, '新'))).toBe('a新d')
  })

  it('在格式或链接 run 内插入和删空时继承语义', () => {
    expect(replaceInlineRange('~~目标~~', 1, 1, '新')).toBe('~~目新标~~')
    expect(replaceInlineRange('[目标](https://example.com)', 1, 1, '新')).toBe('[目新标](https://example.com)')
    expect(replaceInlineRange('[目标](https://example.com)', 0, 2, '')).toBe('')
  })

  it('针对纯文字选区切换格式，并可再次取消', () => {
    const bold = toggleInlineFormat('abcdef', 1, 4, 'bold')
    expect(bold).toBe('a**bcd**ef')
    expect(inlineFormatActive(bold, 1, 4, 'bold')).toBe(true)
    expect(toggleInlineFormat(bold, 1, 4, 'bold')).toBe('abcdef')
    expect(toggleInlineFormat('abcdef', 0, 6, 'highlight')).toBe('==abcdef==')
    expect(toggleInlineFormat('abcdef', 0, 6, 'underline')).toBe('<u>abcdef</u>')
  })

  it('高亮与行内代码互斥，清除样式时保留链接', () => {
    expect(toggleInlineFormat('==abcdef==', 0, 6, 'code')).toBe('`abcdef`')
    expect(toggleInlineFormat('`abcdef`', 0, 6, 'highlight')).toBe('==abcdef==')
    expect(clearInlineFormats('[***abc***](https://example.com)', 0, 3)).toBe('[abc](https://example.com)')
  })

  it('给部分文案添加链接，并更新 / 移除这一处链接', () => {
    const linked = setInlineLink('访问桥水官网', 2, 6, 'https://bridgewater.com')
    expect(linked).toBe('访问[桥水官网](https://bridgewater.com)')
    const link = parseInlineSegments(linked).find((segment) => segment.link)?.link
    expect(link).not.toBeNull()
    const updated = updateInlineLink(linked, link!.rawStart, link!.rawEnd, 'https://example.com')
    expect(updated).toBe('访问[桥水官网](https://example.com)')
    const updatedLink = parseInlineSegments(updated).find((segment) => segment.link)?.link
    expect(updateInlineLink(updated, updatedLink!.rawStart, updatedLink!.rawEnd, null)).toBe('访问桥水官网')
  })
})
