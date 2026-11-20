import { describe, expect, it } from "bun:test"
import { MarkdownPreviewPage } from "../src/components/markdown/MarkdownPreviewPage"
import { MarkdownView } from "../src/components/markdown/MarkdownView"
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "../src/utils/markdown/parse"

const render = (source: string) =>
  String(<MarkdownView blocks={parseMarkdown(source)} />)

describe("markdown renderer - blocks", () => {
  it("renders headings and joins wrapped paragraph lines with a space", () => {
    const html = render("# Title\n\nfirst line\nsecond line")
    expect(html).toBe("<h1>Title</h1><p>first line second line</p>")
  })

  it("renders level 1-6 headings with inline formatting", () => {
    const html = render("### a **b**\n\n###### c")
    expect(html).toContain("<h3>a <strong>b</strong></h3>")
    expect(html).toContain("<h6>c</h6>")
  })

  it("does not treat `#` without a space as a heading", () => {
    expect(render("#notheading")).toBe("<p>#notheading</p>")
  })

  it("turns two trailing spaces into a hard break", () => {
    expect(render("a  \nb")).toBe("<p>a<br/>b</p>")
    expect(render("a\\\nb")).toBe("<p>a<br/>b</p>")
  })

  it("renders fenced code with the language and escaped source", () => {
    const html = render('```ts\nconst a = 1 < 2 && "<b>"\n```')
    expect(html).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; &quot;&lt;b&gt;&quot;</code></pre>',
    )
  })

  it("keeps an unclosed fence as code", () => {
    expect(render("```\nunclosed")).toBe("<pre><code>unclosed</code></pre>")
  })

  it("renders nested and ordered lists", () => {
    expect(render("- a\n- b\n  - c")).toBe(
      "<ul><li>a</li><li><p>b</p><ul><li>c</li></ul></li></ul>",
    )
    expect(render("3. three\n4. four")).toBe(
      '<ol start="3"><li>three</li><li>four</li></ol>',
    )
  })

  it("renders task list checkboxes", () => {
    const html = render("- [x] done\n- [ ] todo")
    expect(html).toContain('checked=""/>done')
    expect(html).toContain('<input type="checkbox" disabled=""/>todo')
  })

  it("renders blockquotes recursively", () => {
    expect(render("> quoted **bold**")).toBe(
      "<blockquote><p>quoted <strong>bold</strong></p></blockquote>",
    )
  })

  it("renders tables with per-column alignment", () => {
    const html = render("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |")
    expect(html).toContain('<th class="md-align-left">a</th>')
    expect(html).toContain('<th class="md-align-center">b</th>')
    expect(html).toContain('<th class="md-align-right">c</th>')
    expect(html).toContain('<td class="md-align-center">2</td>')
  })

  it("does not read a heading underline as a table", () => {
    expect(render("Title\n---")).toBe("<p>Title</p><hr/>")
  })

  it("renders a thematic break", () => {
    expect(render("---")).toBe("<hr/>")
  })
})

describe("markdown renderer - inline", () => {
  it("renders emphasis, strike and code spans", () => {
    expect(render("**bold** *em* _em_ ~~del~~ `code`")).toBe(
      "<p><strong>bold</strong> <em>em</em> <em>em</em> <del>del</del> <code>code</code></p>",
    )
  })

  it("keeps escaped markers as text", () => {
    expect(render("\\*not em\\*")).toBe("<p>*not em*</p>")
  })

  it("does not emphasise snake_case or arithmetic", () => {
    expect(render("snake_case_word and 2 * 3 * 4")).toBe(
      "<p>snake_case_word and 2 * 3 * 4</p>",
    )
  })

  it("renders relative links with a title", () => {
    expect(render('[doc](./a.md "T")')).toBe(
      '<p><a href="./a.md" title="T" rel="noreferrer">doc</a></p>',
    )
  })

  it("renders http links and bare URLs", () => {
    expect(render("[x](https://example.com/a)")).toContain(
      '<a href="https://example.com/a" rel="noreferrer">x</a>',
    )
    expect(render("see https://example.com/a?b=1.")).toContain(
      '<a href="https://example.com/a?b=1" rel="noreferrer">https://example.com/a?b=1</a>.',
    )
  })

  it("keeps a link with a disallowed scheme as literal text", () => {
    expect(render("[x](javascript:alert(1))")).toBe(
      '<p><span class="md-literal">[x](javascript:alert(1))</span></p>',
    )
    expect(render("[x](//evil.example/a)")).toBe(
      '<p><span class="md-literal">[x](//evil.example/a)</span></p>',
    )
  })

  it("renders same-origin images and rejects external ones", () => {
    expect(render("![alt](./img/a.png)")).toBe(
      '<p><img src="./img/a.png" alt="alt" loading="lazy"/></p>',
    )
    expect(render("![alt](https://evil.example/a.png)")).toBe(
      '<p><span class="md-literal">![alt](https://evil.example/a.png)</span></p>',
    )
  })

  it("escapes raw HTML instead of rendering it", () => {
    const html = render("<img src=x onerror=alert(1)>")
    expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>")
    expect(html).not.toContain("<img")
  })

  it("keeps a backtick run longer than the span limit as text", () => {
    const runs = "`".repeat(200)
    expect(render(`a${runs}`)).toBe(`<p>a${runs}</p>`)
  })

  it("escapes quotes in attribute values", () => {
    expect(render('[x](/a"b)')).toContain('href="/a&quot;b"')
  })
})

describe("markdown preview page", () => {
  it("renders a standalone document with the file name as the title", () => {
    const html = String(
      <MarkdownPreviewPage fileName="readme.md" content="# Hi" />,
    )
    expect(html).toContain("<title>readme.md</title>")
    expect(html).toContain("<h1>Hi</h1>")
    // プレビューは HTMX / Tailwind CDN に依存しない
    expect(html).not.toContain("htmx")
    expect(html).not.toContain("cdn.jsdelivr.net")
  })

  it("starts with a doctype so the document renders in standards mode", () => {
    const html = String(<MarkdownPreviewPage fileName="a.md" content="x" />)
    expect(html.startsWith("<!doctype html>")).toBe(true)
  })

  it("escapes the file name in the title", () => {
    const html = String(
      <MarkdownPreviewPage fileName="<svg/onload=alert(1)>" content="x" />,
    )
    expect(html).toContain("<title>&lt;svg/onload=alert(1)&gt;</title>")
    expect(html).not.toContain("<svg/onload")
  })

  it("shows an empty state for a blank file", () => {
    const html = String(
      <MarkdownPreviewPage fileName="empty.md" content={" \n"} />,
    )
    expect(html).toContain("This file is empty.")
  })

  it("falls back to the source when the file is too large to parse", () => {
    const content = `# Hi\n\n${"x".repeat(MARKDOWN_MAX_LENGTH)}`
    const html = String(
      <MarkdownPreviewPage fileName="big.md" content={content} />,
    )
    expect(html).toContain("too large to render as Markdown")
    expect(html).toContain('<pre class="md-plain">')
    expect(html).not.toContain("<h1>Hi</h1>")
  })
})

describe("markdown renderer - heading edge cases", () => {
  it("drops the closing hash sequence", () => {
    expect(render("## Title ##")).toBe("<h2>Title</h2>")
  })

  it("does not treat a long unclosed link label as a link", () => {
    const html = render(`[${"a".repeat(4096)}`)
    expect(html).not.toContain("<a ")
    expect(html).toContain("aaaa")
  })
})
