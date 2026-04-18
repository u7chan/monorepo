export interface FileItem {
  name: string
  type: "file" | "dir"
  size?: number
  mtime?: Date
}
