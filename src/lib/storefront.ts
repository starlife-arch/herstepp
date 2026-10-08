// Shared loader for the public storefront settings (hero carousel +
// announcement bar). One fetch per page-load, cached in memory for 60 s to
// match the edge cache; Home and Layout both read through this so the API is
// hit at most once. apiFetch adds a Bearer token when signed in — harmless
// here since /api/hero and /api/announcement are public.
import { apiFetch } from './api';

export type HeroMedia = { url: string; publicId: string; resourceType: 'image' | 'video' };
export type HeroSlide = {
  title: string;
  copy: string;
  ctaLabel: string;
  ctaUrl: string;
  media: HeroMedia;
  mobileMedia: HeroMedia | null;
  focalPoint: string;
};
export type HeroData = { enabled: boolean; slides: HeroSlide[] };
export type AnnouncementData = { enabled: boolean; message: string; linkUrl: string; linkLabel: string };

const TTL_MS = 60 * 1000;
type Entry<T> = { value: T; expires: number };
const heroCache: { entry: Entry<HeroData | null> | null } = { entry: null };
const announcementCache: { entry: Entry<AnnouncementData | null> | null } = { entry: null };

export async function loadHero(): Promise<HeroData | null> {
  if (heroCache.entry && heroCache.entry.expires > Date.now()) return heroCache.entry.value;
  try {
    const res = await apiFetch('/api/hero');
    const value = (res?.hero ?? null) as HeroData | null;
    heroCache.entry = { value, expires: Date.now() + TTL_MS };
    return value;
  } catch {
    // A failed lookup should not lock the static hero in for the session.
    return null;
  }
}

export async function loadAnnouncement(): Promise<AnnouncementData | null> {
  if (announcementCache.entry && announcementCache.entry.expires > Date.now()) return announcementCache.entry.value;
  try {
    const res = await apiFetch('/api/announcement');
    const value = (res?.announcement ?? null) as AnnouncementData | null;
    announcementCache.entry = { value, expires: Date.now() + TTL_MS };
    return value;
  } catch {
    return null;
  }
}

// Cloudinary delivery helpers: f_auto/q_auto format+quality optimisation with
// a sensible width. Works for both the https delivery URL and bare public ids.
export function heroImageUrl(media: HeroMedia | null, width: number): string {
  if (!media?.url) return '';
  if (!media.url.includes('/upload/')) return media.url;
  const transform = `f_auto,q_auto,w_${width}`;
  return media.url.replace('/upload/', `/upload/${transform}/`);
}

export function heroVideoUrl(media: HeroMedia | null): string {
  if (!media?.url) return '';
  if (!media.url.includes('/upload/')) return media.url;
  return media.url.replace('/upload/', '/upload/f_auto,q_auto/');
}
