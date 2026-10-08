import { useEffect } from 'react';

const NOINDEX = 'noindex';

/**
 * Sets document.title and the meta description for a page.
 * `noindex` adds/updates <meta name="robots" content="noindex"> (private pages).
 * Does not touch anything else — no visual changes.
 */
export function usePageMeta(title: string, description?: string, noindex = false) {
  useEffect(() => {
    if (title) document.title = title;
    if (description) {
      let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
      if (!tag) {
        tag = document.createElement('meta');
        tag.name = 'description';
        document.head.appendChild(tag);
      }
      tag.content = description;
    }
    if (noindex) {
      let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.appendChild(robots);
      }
      robots.content = NOINDEX;
    }
    // Intentionally not removing state on unmount: SPA navigation should keep
    // the last page's meta until the next page sets its own.
  }, [title, description, noindex]);
}
