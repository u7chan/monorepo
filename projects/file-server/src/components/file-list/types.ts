export interface FileItem {
  name: string
  type: "file" | "dir"
  size?: number
  mtime?: Date
}

export interface BrowseEntry extends FileItem {
  path: string
  canRename: boolean
  canDelete: boolean
  canMove: boolean
  badge?: string
}

export interface BrowseCrumb {
  label: string
  path: string
}

export interface BrowseViewModel {
  breadcrumbs: BrowseCrumb[]
  entries: BrowseEntry[]
  actionPath?: string
  archivePath?: string
  canCreate: boolean
  canUpload: boolean
}
