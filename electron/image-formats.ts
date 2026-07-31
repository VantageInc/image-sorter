export const RAW_IMAGE_EXTENSIONS = new Set([
  '.arw',
  '.cr2',
  '.cr3',
  '.crw',
  '.dng',
  '.nef',
  '.nrw',
  '.orf',
  '.pef',
  '.raf',
  '.rw2',
  '.sr2',
  '.srf',
  '.srw',
  '.x3f',
]);

export const VECTOR_IMAGE_EXTENSIONS = new Set(['.ai', '.eps', '.svg']);

export const ADOBE_DOCUMENT_EXTENSIONS = new Set(['.ai', '.eps', '.psb', '.psd']);

export const NATIVE_IMAGE_EXTENSIONS = new Set([
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.tga',
  '.webp',
]);

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ...RAW_IMAGE_EXTENSIONS,
  ...VECTOR_IMAGE_EXTENSIONS,
  ...ADOBE_DOCUMENT_EXTENSIONS,
  ...NATIVE_IMAGE_EXTENSIONS,
  '.avif',
  '.dds',
  '.exr',
  '.hdr',
  '.heic',
  '.heif',
  '.jxl',
  '.pdf',
  '.tif',
  '.tiff',
]);

export function isSupportedImageExtension(extension: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}
