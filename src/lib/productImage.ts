// ONE helper for every product image in the app. Firestore stores images as
// objects {url, publicId, resourceType}, but older/legacy docs may hold a
// plain string, an `image` field or an `imageUrl` field — and damaged docs may
// hold nothing at all. This function NEVER returns an object (which would
// render as "/[object Object]") and NEVER returns undefined (broken <img>).
import type { SyntheticEvent } from 'react';
import type { Product } from '../types';

export const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
      `<rect width="100%" height="100%" fill="#f5f5f4"/>` +
      `<path d="M140 260l50-70 35 45 25-30 40 55z" fill="#d6d3d1"/>` +
      `<circle cx="160" cy="160" r="20" fill="#d6d3d1"/>` +
      `</svg>`
  );

type LooseProduct = Partial<Product> & Record<string, unknown>;

export function productImageUrl(p?: LooseProduct | null): string {
  const first = Array.isArray(p?.images) ? (p!.images as unknown[])[0] : undefined;
  // New shape: { url, publicId, resourceType }
  if (first && typeof first === 'object' && typeof (first as any).url === 'string' && (first as any).url) {
    return (first as any).url as string;
  }
  // Legacy shape: images used to be plain URL strings.
  if (typeof first === 'string' && first) return first;
  // Other legacy single-image fields.
  const legacyImage = (p as any)?.image;
  if (typeof legacyImage === 'string' && legacyImage) return legacyImage;
  if (legacyImage && typeof legacyImage === 'object' && typeof legacyImage.url === 'string' && legacyImage.url) {
    return legacyImage.url;
  }
  const legacyUrl = (p as any)?.imageUrl;
  if (typeof legacyUrl === 'string' && legacyUrl) return legacyUrl;
  // Nothing usable — neutral placeholder, never a crash / [object Object].
  return PLACEHOLDER_IMAGE;
}

// Image URL stored on an ORDER item (server writes item.imageUrl as a string).
export function orderItemImageUrl(item?: { imageUrl?: string | null } | null): string {
  const url = item?.imageUrl;
  if (typeof url === 'string' && url) return url;
  if (url && typeof url === 'object') {
    const inner = (url as any).url;
    if (typeof inner === 'string' && inner) return inner;
  }
  return PLACEHOLDER_IMAGE;
}

// Use on every <img onError> so a dead Cloudinary URL also degrades gracefully.
export function handleImageError(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  if (img.src !== PLACEHOLDER_IMAGE) {
    img.src = PLACEHOLDER_IMAGE;
  }
}
