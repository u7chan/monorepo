import * as mime from "mime-types"

const DEFAULT_MIME_TYPE = "application/octet-stream"

export const lookupMimeType = (filePath: string) => {
  const mimeType = mime.lookup(filePath)
  return typeof mimeType === "string" ? mimeType : DEFAULT_MIME_TYPE
}

const isUtf8TextMime = (mimeType: string) =>
  /^text\//.test(mimeType) ||
  mimeType === "application/javascript" ||
  mimeType === "application/json" ||
  mimeType === "application/xml" ||
  mimeType === "image/svg+xml" ||
  mimeType.endsWith("+json") ||
  mimeType.endsWith("+xml")

export const normalizeResponseMimeType = (mimeType: string) => {
  const [baseMimeType] = mimeType.split(";")
  const normalizedMimeType =
    baseMimeType?.trim().toLowerCase() || DEFAULT_MIME_TYPE

  if (!isUtf8TextMime(normalizedMimeType)) {
    return normalizedMimeType
  }

  if (/;\s*charset=/i.test(mimeType)) {
    return mimeType
  }

  return `${normalizedMimeType}; charset=utf-8`
}

export const resolveResponseMimeType = (filePath: string) =>
  normalizeResponseMimeType(lookupMimeType(filePath))
