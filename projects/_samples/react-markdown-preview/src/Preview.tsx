import MarkdownPreview from "@uiw/react-markdown-preview";

const source = `
## MarkdownPreview

> todo: React component preview markdown text.
`;

export function Preview() {
  return <MarkdownPreview source={source} style={{ padding: 16 }} />;
}
