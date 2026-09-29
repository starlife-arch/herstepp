import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Truck, Shield, Clock, MapPin, Star, Sparkles } from 'lucide-react';
import { products, categories } from '../data/mockData';
import { Button, Card, formatCurrency } from '../components/ui';

export default function Home() {
  const featured = products.filter(p => p.isFeatured);
  const newArrivals = products.filter(p => p.isNewArrival);
  const bestsellers = products.filter(p => p.isBestseller);

  return (
    <div className="animate-fadeIn">
      {/* Hero Section */}
      <section className="relative bg-neutral-950 text-white overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-neutral-900 via-neutral-950 to-black" />
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url(https://images.unsplash.com/photo-1560343090-f0409e92791a?w=1200&h=600&fit=crop)', backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 py-20 sm:py-32">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-neutral-400 mb-3 uppercase tracking-wider">Premium Ladies Footwear</p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-tight mb-6">
              Step Into<br />Your <span className="text-neutral-400">Style.</span>
            </h1>
            <p className="text-lg text-neutral-300 mb-8 max-w-lg leading-relaxed">
              Discover curated ladies' footwear at HerStep Collection. From elegant heels to comfortable flats, find your perfect pair in Juja Town.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to="/shop">
                <Button size="lg" className="bg-white text-neutral-900 hover:bg-neutral-100">
                  Shop Now <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
              <Link to="/track">
                <Button variant="outline" size="lg" className="border-neutral-600 text-white hover:bg-white/10">
                  Track Order
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Promo Banner */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8">
        <div className="bg-neutral-100 border border-neutral-200 rounded-xl px-5 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-neutral-900 text-sm">Use code HERSTEP10 for 10% off your first order</p>
            <p className="text-xs text-neutral-500 mt-0.5">Minimum order KSh 500. Valid until December 2026.</p>
          </div>
          <Link to="/shop">
            <Button variant="outline" size="sm">Shop Now</Button>
          </Link>
        </div>
      </section>

      {/* Categories */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-bold text-neutral-900">Shop by Category</h2>
          <Link to="/shop" className="text-sm font-medium text-neutral-600 hover:text-neutral-900 flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {categories.slice(0, 8).map(cat => (
            <Link key={cat.id} to={`/shop?category=${cat.slug}`} className="group">
              <Card hover className="p-5 text-center">
                <p className="font-medium text-neutral-900 group-hover:text-neutral-700 text-sm">{cat.name}</p>
                <p className="text-xs text-neutral-500 mt-1">{cat.productCount} products</p>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* Featured Products */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-bold text-neutral-900">Featured</h2>
          <Link to="/shop" className="text-sm font-medium text-neutral-600 hover:text-neutral-900 flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {featured.map(product => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>

      {/* New Arrivals */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-neutral-700" />
            <h2 className="text-2xl font-bold text-neutral-900">New Arrivals</h2>
          </div>
          <Link to="/shop?sort=newest" className="text-sm font-medium text-neutral-600 hover:text-neutral-900 flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {newArrivals.map(product => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>

      {/* Why Shop With Us */}
      <section className="bg-neutral-50 border-y border-neutral-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
          <h2 className="text-2xl font-bold text-neutral-900 text-center mb-10">Why Shop With HerStep</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { icon: Shield, title: 'Quality Assured', desc: 'Every pair is carefully inspected before sale' },
              { icon: Truck, title: 'Fast Delivery', desc: 'Same-day delivery available in Juja Town' },
              { icon: Clock, title: 'Easy Returns', desc: 'Hassle-free exchange within 48 hours' },
              { icon: MapPin, title: 'Visit Our Store', desc: 'Jerry House, near Juja Posta, Shop No. 12' },
            ].map((item, i) => (
              <div key={i} className="text-center">
                <div className="w-12 h-12 bg-white border border-neutral-200 rounded-xl flex items-center justify-center mx-auto mb-3">
                  <item.icon className="w-5 h-5 text-neutral-700" />
                </div>
                <h3 className="font-semibold text-neutral-900 text-sm mb-1">{item.title}</h3>
                <p className="text-xs text-neutral-500">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bestsellers */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <Star className="w-5 h-5 text-neutral-700" />
            <h2 className="text-2xl font-bold text-neutral-900">Bestsellers</h2>
          </div>
          <Link to="/shop?sort=popular" className="text-sm font-medium text-neutral-600 hover:text-neutral-900 flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {bestsellers.map(product => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </section>

      {/* Store Info */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <Card className="p-8 sm:p-12 bg-neutral-900 text-white border-0">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold mb-3">Visit Our Store</h2>
            <p className="text-neutral-300 mb-6 leading-relaxed">
              Come see our collection in person. We are located in Juja Town and happy to help you find the perfect pair.
            </p>
            <div className="space-y-2 text-sm text-neutral-400">
              <p>Jerry House, near Juja Posta</p>
              <p>Outside Shop No. 12</p>
              <p className="pt-2">Phone: +254 799 021 089</p>
              <p>WhatsApp: +254 106 624 924</p>
            </div>
          </div>
        </Card>
      </section>
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
          <img
            src={product.images[0]}
            alt={product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
          {isSoldOut && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <span className="bg-white text-neutral-900 px-3 py-1 rounded-full text-xs font-bold">SOLD OUT</span>
            </div>
          )}
          {product.salePrice && !isSoldOut && (
            <div className="absolute top-2 left-2">
              <span className="bg-red-600 text-white px-2 py-0.5 rounded text-xs font-medium">Sale</span>
            </div>
          )}
          {product.isNewArrival && !isSoldOut && (
            <div className="absolute top-2 right-2">
              <span className="bg-neutral-900 text-white px-2 py-0.5 rounded text-xs font-medium">New</span>
            </div>
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
          {!isSoldOut && availableSizes.length > 0 && (
            <p className="text-xs text-neutral-400">Sizes: {availableSizes.join(', ')}</p>
          )}
        </div>
      </Card>
    </Link>
  );
}
