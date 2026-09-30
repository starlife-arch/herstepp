import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Skeleton, Button, EmptyState } from '../components/ui';
import { ProductCard } from './Home';

export default function Shop() {
  const [searchParams] = useSearchParams();
  const { state, reloadCatalog } = useApp();
  const { products, categories, catalogLoading, catalogError } = state;
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  const [selectedSize, setSelectedSize] = useState('');
  const [priceRange, setPriceRange] = useState('');
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'newest');
  const [showFilters, setShowFilters] = useState(false);
  const [availability, setAvailability] = useState('');

  // Every EU size the catalogue actually carries, derived from products.inventory (strings "30".."45").
  const allSizes = useMemo(() => {
    const sizes = new Set<string>();
    products.forEach(p => p.inventory.forEach(i => sizes.add(i.size)));
    return Array.from(sizes).sort((a, b) => Number(a) - Number(b));
  }, [products]);

  const filteredProducts = useMemo(() => {
    let result = [...products];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (categories.find(c => c.id === p.categoryId)?.name || '').toLowerCase().includes(q)
      );
    }
    if (selectedCategory) {
      result = result.filter(p => p.categoryId === selectedCategory);
    }
    if (selectedSize) {
      result = result.filter(p => p.inventory.some(s => s.size === selectedSize && s.quantity > 0));
    }
    if (priceRange) {
      const [min, max] = priceRange.split('-').map(Number);
      result = result.filter(p => {
        const price = p.salePrice ?? p.price;
        return price >= min && (!max || price <= max);
      });
    }
    if (availability === 'in_stock') {
      result = result.filter(p => p.stockQuantity > 0);
    } else if (availability === 'sold_out') {
      result = result.filter(p => p.stockQuantity === 0);
    }

    switch (sortBy) {
      case 'price_low': result.sort((a, b) => (a.salePrice ?? a.price) - (b.salePrice ?? b.price)); break;
      case 'price_high': result.sort((a, b) => (b.salePrice ?? b.price) - (a.salePrice ?? a.price)); break;
      case 'popular': result.sort((a, b) => (b.bestseller ? 1 : 0) - (a.bestseller ? 1 : 0)); break;
      case 'newest': result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); break;
    }
    return result;
  }, [products, categories, search, selectedCategory, selectedSize, priceRange, sortBy, availability]);

  if (catalogError) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <EmptyState
          title="We couldn't load the shop"
          description={catalogError}
          action={<Button onClick={() => void reloadCatalog()}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-neutral-900 mb-2">Shop</h1>
        <p className="text-neutral-500">Browse our collection of premium ladies' footwear</p>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input
            type="text"
            placeholder="Search products, categories, SKU..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-neutral-300 rounded-lg text-sm focus:border-neutral-900"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="px-3 py-2.5 border border-neutral-300 rounded-lg text-sm bg-white"
          >
            <option value="newest">Newest</option>
            <option value="price_low">Price: Low to High</option>
            <option value="price_high">Price: High to Low</option>
            <option value="popular">Popularity</option>
          </select>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 px-4 py-2.5 border border-neutral-300 rounded-lg text-sm hover:bg-neutral-50"
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Filters</span>
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-white border border-neutral-200 rounded-xl p-5 mb-6 animate-fadeIn">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">Category</label>
              <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm bg-white">
                <option value="">All Categories</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">Size</label>
              <select value={selectedSize} onChange={e => setSelectedSize(e.target.value)} className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm bg-white">
                <option value="">All Sizes</option>
                {allSizes.map(s => <option key={s} value={s}>Size {s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">Price Range</label>
              <select value={priceRange} onChange={e => setPriceRange(e.target.value)} className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm bg-white">
                <option value="">Any Price</option>
                <option value="0-500">Under KSh 500</option>
                <option value="500-700">KSh 500 - 700</option>
                <option value="700-1000">KSh 700 - 1,000</option>
                <option value="1000-99999">Above KSh 1,000</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">Availability</label>
              <select value={availability} onChange={e => setAvailability(e.target.value)} className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm bg-white">
                <option value="">All Products</option>
                <option value="in_stock">In Stock</option>
                <option value="sold_out">Sold Out</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <button onClick={() => { setSelectedCategory(''); setSelectedSize(''); setPriceRange(''); setAvailability(''); }} className="text-sm text-neutral-600 hover:text-neutral-900">
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* Results count */}
      <p className="text-sm text-neutral-500 mb-4">
        {catalogLoading ? 'Loading products…' : `${filteredProducts.length} product${filteredProducts.length !== 1 ? 's' : ''} found`}
      </p>

      {/* Product Grid */}
      {catalogLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="aspect-square bg-neutral-100" />
              <div className="p-3 sm:p-4 space-y-2">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </Card>
          ))}
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-neutral-500 text-lg mb-2">No products found</p>
          <p className="text-neutral-400 text-sm">Try adjusting your filters or search terms</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {filteredProducts.map(product => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
