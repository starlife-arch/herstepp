// ---------------------------------------------------------------------------
// api/_lib/hero.js — THE single source of truth for the Home hero carousel and
// the announcement bar settings (backend). Shared by:
//   * routes/hero-public      (GET /api/hero, GET /api/announcement)
//   * routes/admin-hero       (GET/PATCH /api/admin/hero, /api/admin/announcement)
//   * scripts/test-hero.mjs   (offline tests)
//
// Data contract (see AGENTS.md):
//   settings/hero = { enabled: bool, slides: [1..8] } where each slide is
//     { title<=160, copy<=500, ctaLabel<=80, ctaUrl (# | / | https://),
//       media: { url (https), publicId, resourceType 'image'|'video' },
//       mobileMedia: image-only | null, focalPoint (3x3 grid, default center) }
//   settings/announcement = { enabled: bool, message<=500, linkUrl (https)|'',
//     linkLabel<=80 }
// Legacy single-banner documents ({ imageUrl | videoUrl, title, copy, ctaLabel,
// ctaUrl }) are normalised into one slide so old data keeps working.
// ---------------------------------------------------------------------------

export const HERO_INVALID_MESSAGE = 'Provide a headline, copy, CTA, secure Cloudinary media, and an optional mobile image for every hero slide.';

export const FOCAL_POINTS = Object.freeze([
  'left top', 'center top', 'right top',
  'left center', 'center center', 'right center',
  'left bottom', 'center bottom', 'right bottom',
]);

export const DEFAULT_FOCAL_POINT = 'center center';

const MAX_SLIDES = 8;

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpsUrl(value) {
  const s = str(value);
  if (!s.toLowerCase().startsWith('https://')) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

function isCtaUrl(value) {
  const s = str(value);
  if (!s) return false;
  if (s.startsWith('#') || s.startsWith('/')) return s.length > 1;
  return isHttpsUrl(s);
}

function normaliseMedia(raw, allowedTypes) {
  if (!raw || typeof raw !== 'object') return null;
  const url = str(raw.url);
  const publicId = str(raw.publicId);
  const resourceType = str(raw.resourceType).toLowerCase();
  if (!isHttpsUrl(url) || !publicId) return null;
  if (!allowedTypes.includes(resourceType)) return null;
  return { url, publicId, resourceType };
}

/** One slide from a raw object, or null when unusable. */
function normaliseSlide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title);
  const copy = str(raw.copy);
  const ctaLabel = str(raw.ctaLabel);
  const ctaUrl = str(raw.ctaUrl);
  if (!title || title.length > 160) return null;
  if (!copy || copy.length > 500) return null;
  if (!ctaLabel || ctaLabel.length > 80) return null;
  if (!isCtaUrl(ctaUrl)) return null;
  const media = normaliseMedia(raw.media, ['image', 'video']);
  if (!media) return null;
  // mobileMedia only makes sense for images; anything else is dropped.
  let mobileMedia = null;
  if (raw.mobileMedia && typeof raw.mobileMedia === 'object') {
    const candidate = { ...raw.mobileMedia, resourceType: 'image' };
    mobileMedia = normaliseMedia(candidate, ['image']);
  }
  const focalPoint = FOCAL_POINTS.includes(str(raw.focalPoint)) ? str(raw.focalPoint) : DEFAULT_FOCAL_POINT;
  return { title, copy, ctaLabel, ctaUrl, media, mobileMedia, focalPoint };
}

/**
 * Tolerant read of a settings/hero document (or a bare legacy banner):
 * legacy { imageUrl | videoUrl, title, copy, ctaLabel, ctaUrl } becomes one
 * slide. Invalid input yields { enabled:false, slides:[] } so the public route
 * answers hero:null instead of throwing.
 */
export function normalizeHero(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let slides = Array.isArray(src.slides) ? src.slides : [];
  if (slides.length === 0 && (str(src.imageUrl) || str(src.videoUrl))) {
    const media = str(src.videoUrl)
      ? { url: str(src.videoUrl), publicId: str(src.videoPublicId) || 'legacy-video', resourceType: 'video' }
      : { url: str(src.imageUrl), publicId: str(src.imagePublicId) || 'legacy-image', resourceType: 'image' };
    slides = [{
      title: str(src.title),
      copy: str(src.copy),
      ctaLabel: str(src.ctaLabel),
      ctaUrl: str(src.ctaUrl),
      media,
      mobileMedia: null,
      focalPoint: str(src.focalPoint),
    }];
  }
  const cleaned = slides.map(normaliseSlide).filter(Boolean).slice(0, MAX_SLIDES);
  return { enabled: src.enabled === true, slides: cleaned };
}

/** Strict validation for admin writes. Throws Error with the contract text. */
export function validateHeroSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (typeof src.enabled !== 'boolean') throw new Error(HERO_INVALID_MESSAGE);
  if (!Array.isArray(src.slides)) throw new Error(HERO_INVALID_MESSAGE);
  if (src.slides.length < 1 || src.slides.length > MAX_SLIDES) throw new Error(HERO_INVALID_MESSAGE);
  const slides = [];
  for (const slide of src.slides) {
    const cleaned = normaliseSlide(slide);
    if (!cleaned) throw new Error(HERO_INVALID_MESSAGE);
    slides.push(cleaned);
  }
  return { enabled: src.enabled, slides };
}

/** Tolerant read of settings/announcement. */
export function normalizeAnnouncement(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const message = str(src.message).slice(0, 500);
  const linkUrl = str(src.linkUrl);
  const linkLabel = str(src.linkLabel).slice(0, 80);
  return {
    enabled: src.enabled === true && Boolean(message),
    message,
    linkUrl: isHttpsUrl(linkUrl) ? linkUrl : '',
    linkLabel: linkUrl && isHttpsUrl(linkUrl) ? linkLabel : '',
  };
}

/** Strict validation for admin writes. */
export function validateAnnouncementSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (typeof src.enabled !== 'boolean') throw new Error('Provide an enabled switch and a message up to 500 characters.');
  const message = str(src.message);
  if (message.length > 500) throw new Error('The announcement message must be at most 500 characters.');
  if (src.enabled && !message) throw new Error('A visible announcement needs a message.');
  const linkUrl = str(src.linkUrl);
  if (linkUrl && !isHttpsUrl(linkUrl)) throw new Error('The announcement link must be a secure https:// URL.');
  const linkLabel = str(src.linkLabel);
  if (linkLabel.length > 80) throw new Error('The announcement link label must be at most 80 characters.');
  if (linkLabel && !linkUrl) throw new Error('A link label needs a link URL.');
  return { enabled: src.enabled, message, linkUrl, linkLabel };
}
