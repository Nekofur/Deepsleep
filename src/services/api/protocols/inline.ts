import type { FileBlockParam } from '../types.js'
import type { LoadedAttachment } from './types.js'
import { MAX_INLINE_BYTES } from './types.js'

/** 常见可内联的附件类型；其余类型（Office 文档、压缩包等）内联后服务端也不会解析 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
}

/** 只有图片和 PDF 能作为内联内容被各家接口接受 */
export const canInline = (mediaType: string) =>
  mediaType.startsWith('image/') || mediaType === 'application/pdf'

export const guessMediaType = (name: string) => {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : ''
}

/** 读取 Blob 的 base64（不含 data URL 前缀）；过大或无法解码时返回 null */
export const readInline = async (
  blob: Blob,
  fallbackType = ''
): Promise<LoadedAttachment | null> => {
  const mediaType = blob.type || fallbackType
  if (!canInline(mediaType) || blob.size > MAX_INLINE_BYTES) {
    return null
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    return base64 ? { mediaType, base64, bytes: blob.size } : null
  } catch {
    return null
  }
}

export const dataUrl = (mediaType: string, base64: string) => `data:${mediaType};base64,${base64}`

/** 文件块的本地原件位置；只有文件 ID 且本地没有提示时无法内联 */
export const localRef = (block: FileBlockParam): { id: string; mediaType: string } | null => {
  if (block.source.type === 'local') {
    return { id: block.source.id, mediaType: block.source.media_type }
  }
  return block.local ? { id: block.local.id, mediaType: block.local.media_type } : null
}
