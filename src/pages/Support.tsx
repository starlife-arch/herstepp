import React from 'react';
import { Link } from 'react-router-dom';
import { LifeBuoy } from 'lucide-react';
import { Card, Button } from '../components/ui';

// Support tickets are a Phase 2 feature: there is no backend for them yet, so
// this page shows a clear "Coming soon" card instead of the old fake-ticket UI.
export default function Support() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 animate-fadeIn">
      <Card className="p-10 text-center">
        <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-100 flex items-center justify-center">
          <LifeBuoy className="w-6 h-6 text-neutral-400" />
        </div>
        <h1 className="text-2xl font-bold text-neutral-900 mb-2">Support</h1>
        <p className="text-sm text-neutral-500 max-w-md mx-auto mb-6">
          Live support chat and ticket tracking are coming soon. Nothing here is
          fake or hardcoded — this section opens in Phase 2.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/track">
            <Button variant="outline">Track an order</Button>
          </Link>
          <Link to="/contact">
            <Button>Contact us</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
