export function slugifyProductName(name: string): string {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '') || 'shoe';
}

export function productPath(product: { id: string; name: string; slug?: string | null }): string {
  return '/product/' + encodeURIComponent(product.slug || slugifyProductName(product.name));
}
