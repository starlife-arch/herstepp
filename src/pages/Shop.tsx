import React, { useState, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, X, ChevronDown } from 'lucide-react';
import { products, categories } from '../data/mockData';
import { Card, Badge, formatCurrency, Button } from '../components/ui';

export default function Shop() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  const [selectedSize, setSelectedSize] = useState('');
  const [priceRange, setPriceRange] = useState('');
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'newest');
  const [showFilters, setShowFilters] = useState(false);
  const [availability, setAvailability] = useState('');

  const filteredProducts = useMemo(() => {
    let result = [...products];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    if (selectedCategory) {
      result = result.filter(p => p.category.toLowerCase().replace(/\s+/g, '-') === selectedCategory || p.category === selectedCategory);
    }
    if (selectedSize) {
      result = result.filter(p => p.sizes.some(s => s.size === parseInt(selectedSize) && s.quantity > 0));
    }
    if (priceRange) {
      const [min, max] = priceRange.split('-').map(Number);
      result = result.filter(p => {
        const price = p.salePrice || p.price;
        return price >= min && (!max || price <= max);
      });
    }
    if (availability === 'in_stock') {
      result = result.filter(p => p.sizes.some(s => s.quantity > 0));
    } else if (availability === 'sold_out') {
      result = result.filter(p => !p.sizes.some(s => s.quantity > 0));
    }

    switch (sortBy) {
      case 'price_low': result.sort((a, b) => (a.salePrice || a.price) - (b.salePrice || b.price)); break;
      case 'price_high': result.sort((a, b) => (b.salePrice || b.price) - (a.salePrice || a.price)); break;
      case 'popular': result.sort((a, b) => (b.isBestseller ? 1 : 0) - (a.isBestseller ? 1 : 0)); break;
      case 'newest': result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); break;
    }
    return result;
  }, [search, selectedCategory, selectedSize, priceRange, sortBy, availability]);

  const allSizes = [36, 37, 38, 39, 40, 41];

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
                {categories.map(c => <option key={c.id} value={c.slug}>{c.name}</option>)}
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
      <p className="text-sm text-neutral-500 mb-4">{filteredProducts.length} product{filteredProducts.length !== 1 ? 's' : ''} found</p>

      {/* Product Grid */}
      {filteredProducts.length === 0 ? (
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

function ProductCard({ product }: { product: any }) {
  const totalStock = product.sizes.reduce((sum: number, s: any) => sum + s.quantity, 0);
  const isSoldOut = totalStock === 0;
  const availableSizes = product.sizes.filter((s: any) => s.quantity > 0).map((s: any) => s.size);

  return (
    <Link to={`/product/${product.slug}`} className="group">
      <Card hover className="overflow-hidden">
        <div className="relative aspect-square bg-neutral-100 overflow-hidden">
          <img src={product.images[0]} alt={product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
          {isSoldOut && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <span className="bg-white text-neutral-900 px-3 py-1 rounded-full text-xs font-bold">SOLD OUT</span>
            </div>
          )}
          {product.salePrice && !isSoldOut && (
            <div className="absolute top-2 left-2"><span className="bg-red-600 text-white px-2 py-0.5 rounded text-xs font-medium">Sale</span></div>
          )}
          {product.isNewArrival && !isSoldOut && (
            <div className="absolute top-2 right-2"><span className="bg-neutral-900 text-white px-2 py-0.5 rounded text-xs font-medium">New</span></div>
          )}
        </div>
        <div className="p-3 sm:p-4">
          <p className="text-xs text-neutral-500 mb-1">{product.category}</p>
          <h3 className="font-medium text-neutral-900 text-sm leading-tight mb-2 line-clamp-2">{product.name}</h3>
          <div className="flex items-center gap-2 mb-2">
            {product.salePrice ? (
              <>
                <span className="font-semibold text-neutral-900 text-sm">{formatCurrency(product.salePrice)}</span>
                <span className="text-xs text-neutral-400 line-through">{formatCurrency(product.price)}</span>
              </>
            ) : (
              <span className="font-semibold text-neutral-900 text-sm">{formatCurrency(product.price)}</span>
            )}
          </div>
          {!isSoldOut && <p className="text-xs text-neutral-400">Sizes: {availableSizes.join(', ')}</p>}
        </div>
      </Card>
    </Link>
  );
}
