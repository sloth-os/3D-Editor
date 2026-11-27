/*
 * Thumbnails of the built-in models made in this browser (docs/model-store.md, "Thumbnails"): the
 * page's service (queue, cache, workers) and what a tile needs of it.
 */
export {
  ThumbnailError,
  ThumbnailService,
  setThumbnailService,
  thumbnailService,
  type ThumbnailFailure,
  type ThumbnailImage,
  type ThumbnailServiceOptions,
  type ThumbnailSource,
  type ThumbnailStats,
  type ThumbnailTicket,
} from './service';
export type { ThumbnailPriority } from './queue';
export { canonicalParams, thumbnailBuild, thumbnailKey, type ThumbnailSpec } from './keys';
