import React from 'react';
import { Link } from 'react-router-dom';

interface Props { children: React.ReactNode; }
interface State { error: Error | null; }

// Catches render errors in ANY wrapped subtree so one bad page (or one damaged
// Firestore document) can never white-screen the whole storefront.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ui:error-boundary]', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-lg mx-auto px-4 py-20 text-center">
          <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-6 text-2xl">⚠️</div>
          <h2 className="text-xl font-bold text-neutral-900 mb-2">Something went wrong on this page</h2>
          <p className="text-neutral-500 text-sm mb-6">
            Sorry about that — the rest of the site still works. Please refresh or head back to the shop.
          </p>
          <div className="flex flex-col gap-3">
            <button onClick={() => this.setState({ error: null })} className="bg-neutral-900 text-white px-6 py-2.5 rounded-lg text-sm font-medium">Try again</button>
            <Link to="/" className="border border-neutral-300 px-6 py-2.5 rounded-lg text-sm font-medium text-neutral-900 hover:bg-neutral-50">Go home</Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
