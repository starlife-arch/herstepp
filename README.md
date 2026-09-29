# HerStep Collection

**Step Into Your Style.**

A premium e-commerce platform for ladies' footwear, built for the Kenyan market with M-Pesa payment integration.

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn
- Firebase account
- Cloudinary account
- M-Pesa STK Push API provider

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/herstep-collection.git
cd herstep-collection

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your credentials

# Start development server
npm run dev
```

### Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete deployment guide.

**Quick deploy to Vercel:**

1. Push code to GitHub
2. Import repository in Vercel
3. Add environment variables
4. Deploy

---

## Project Structure

```
herstep-collection/
├── api/                    # Vercel Serverless Functions
│   ├── payment/
│   │   ├── initiate.js     # M-Pesa STK Push
│   │   └── callback.js     # Payment confirmation
│   ├── orders/
│   │   └── create.js       # Order creation with validation
│   └── upload/
│       └── sign.js         # Cloudinary upload signing
├── firebase/
│   ├── firestore.rules     # Security rules
│   └── firestore.indexes.json
├── src/
│   ├── components/         # Reusable UI components
│   ├── context/            # React Context (state management)
│   ├── data/               # Mock data (replace with Firebase)
│   ├── pages/              # Page components
│   └── types/              # TypeScript interfaces
├── .env.example            # Environment variables template
├── vercel.json             # Vercel configuration
└── DEPLOYMENT.md           # Complete deployment guide
```

---

## Features

### Customer-Facing
- Product catalog with search, filter, and sort
- Size-aware inventory management
- Shopping cart with promo codes
- M-Pesa STK Push checkout
- Order tracking with timeline
- Real-time support chat
- Customer dashboard

### Admin Panel
- Order management
- Product & inventory management
- Payment tracking
- Support ticket system
- Promotions & discount codes
- Analytics dashboard
- Audit logs

### Security
- Firebase Authentication
- Firestore security rules
- Server-side payment validation
- Atomic inventory transactions
- Idempotent payment callbacks
- No exposed secrets in frontend

---

## Technology Stack

- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Backend:** Vercel Serverless Functions
- **Database:** Firebase Firestore
- **Auth:** Firebase Authentication
- **Storage:** Cloudinary (images/videos)
- **Payments:** M-Pesa STK Push
- **Hosting:** Vercel

---

## Environment Variables

See `.env.example` for all required variables.

**Critical variables:**
- Firebase credentials (client + admin)
- Cloudinary API keys
- M-Pesa payment provider credentials
- Callback URL for payment confirmation

---

## Support

- **Email:** herstepcollection@gmail.com
- **Phone:** +254 799 021 089
- **WhatsApp:** +254 106 624 924
- **Location:** Jerry House, near Juja Posta, Juja Town

---

## License

Proprietary. All rights reserved. HerStep Collection 2026.
