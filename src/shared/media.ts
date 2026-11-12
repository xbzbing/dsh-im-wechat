/**
 * 跨上下文共用的媒体类型（纯类型，与 `limits.ts` 同类）。
 *
 * 入站解密（`ilink/media.ts`）、核心草稿（`superagent/protocol.ts`）与会话 prompt
 * （`prompt-parts.ts`）都只认这四种；宿主 `dsh-attachment` 的 `mediaTypes` 也是同一组。
 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
