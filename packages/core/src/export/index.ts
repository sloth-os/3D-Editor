/*
 * Video export logic shared by the server's ffmpeg export (apps/server/src/video) and the browser's
 * WebCodecs export (apps/web/src/export): parameters and presets, the plan, how frames are rendered
 * (desk-frame.ts, document.ts), the passes and their palette, the frame loop, the manifest and the
 * memory estimates. Nothing here touches Node or the DOM: it runs in render processes and workers.
 */
export * from './errors';
export * from './strict';
export * from './protocol';
export * from './params';
export * from './plan';
export * from './passes';
export * from './screen';
export * from './desk-frame';
export * from './document';
export * from './frames';
export * from './manifest';
export * from './memory';
export * from './timing';
export * from './job';
export * from './png';
