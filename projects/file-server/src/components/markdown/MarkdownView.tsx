import type { FC } from "hono/jsx"
import type {
  MdAlign,
  MdBlock,
  MdInline,
  MdListItem,
} from "../../utils/markdown/types"

const ALIGN_CLASS_NAME: Record<MdAlign, string> = {
  left: "md-align-left",
  center: "md-align-center",
  right: "md-align-right",
}

/** 解析済みのブロック列を HTML へ写す。テキストは JSX のエスケープに任せる */
export const MarkdownView: FC<{ blocks: MdBlock[] }> = ({ blocks }) => (
  <>
    {blocks.map((block) => (
      <MarkdownBlock block={block} />
    ))}
  </>
)

const MarkdownBlock: FC<{ block: MdBlock }> = ({ block }) => {
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6"
      return (
        <Heading>
          <MarkdownInlines nodes={block.inline} />
        </Heading>
      )
    }
    case "paragraph":
      return (
        <p>
          <MarkdownInlines nodes={block.inline} />
        </p>
      )
    case "code":
      return (
        <pre>
          <code className={block.lang ? `language-${block.lang}` : undefined}>
            {block.text}
          </code>
        </pre>
      )
    case "list": {
      const List = block.ordered ? "ol" : "ul"
      return (
        <List start={block.ordered ? block.start : undefined}>
          {block.items.map((item) => (
            <MarkdownListItem item={item} />
          ))}
        </List>
      )
    }
    case "quote":
      return (
        <blockquote>
          <MarkdownView blocks={block.blocks} />
        </blockquote>
      )
    case "table":
      return (
        <div className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    className={ALIGN_CLASS_NAME[block.align[index] ?? "left"]}
                  >
                    <MarkdownInlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr>
                  {row.map((cell, index) => (
                    <td
                      className={ALIGN_CLASS_NAME[block.align[index] ?? "left"]}
                    >
                      <MarkdownInlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "hr":
      return <hr />
  }
}

const MarkdownListItem: FC<{ item: MdListItem }> = ({ item }) => {
  const [first] = item.blocks
  const content =
    item.blocks.length === 1 && first?.kind === "paragraph" ? (
      <MarkdownInlines nodes={first.inline} />
    ) : (
      <MarkdownView blocks={item.blocks} />
    )

  if (item.task === null) {
    return <li>{content}</li>
  }

  return (
    <li className="md-task-item">
      {/* 読み取り専用のチェックボックス。disabled なのでプレビューから状態は変えられない */}
      <input type="checkbox" disabled checked={item.task} />
      {content}
    </li>
  )
}

const MarkdownInlines: FC<{ nodes: MdInline[] }> = ({ nodes }) => (
  <>
    {nodes.map((node) => (
      <MarkdownInline node={node} />
    ))}
  </>
)

const MarkdownInline: FC<{ node: MdInline }> = ({ node }) => {
  switch (node.kind) {
    case "text":
      return <>{node.text}</>
    case "strong":
      return (
        <strong>
          <MarkdownInlines nodes={node.children} />
        </strong>
      )
    case "em":
      return (
        <em>
          <MarkdownInlines nodes={node.children} />
        </em>
      )
    case "del":
      return (
        <del>
          <MarkdownInlines nodes={node.children} />
        </del>
      )
    case "code":
      return <code>{node.text}</code>
    case "link":
      return (
        <a href={node.href} title={node.title ?? undefined} rel="noreferrer">
          <MarkdownInlines nodes={node.children} />
        </a>
      )
    case "image":
      return <img src={node.src} alt={node.alt} loading="lazy" />
    case "break":
      return <br />
    case "literal":
      return <span className="md-literal">{node.text}</span>
  }
}
