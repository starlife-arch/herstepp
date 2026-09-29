# HerStep Collection — Deployment Guide

## Complete step-by-step guide to go live

---

## TABLE OF CONTENTS

1. [Prerequisites](#1-prerequisites)
2. [Firebase Setup](#2-firebase-setup)
3. [Cloudinary Setup](#3-cloudinary-setup)
4. [M-Pesa Payment Provider Setup](#4-m-pesa-payment-provider-setup)
5. [Backend API Functions](#5-backend-api-functions)
6. [Environment Variables](#6-environment-variables)
7. [Vercel Deployment](#7-vercel-deployment)
8. [Custom Domain (Optional)](#8-custom-domain-optional)
9. [Post-Launch Checklist](#9-post-launch-checklist)
10. [Ongoing Maintenance](#10-ongoing-maintenance)

---

## 1. PREREQUISITES

Before starting, ensure you have:

- [ ] A Google account (for Firebase)
- [ ] A Vercel account (sign up at vercel.com)
- [ ] A Cloudinary account (sign up at cloudinary.com)
- [ ] An M-Pesa STK Push API provider account
- [ ] A domain name (optional, e.g., herstepcollection.co.ke)
- [ ] Node.js 18+ installed locally
- [ ] Git installed locally

---

## 2. FIREBASE SETUP

### Step 2.1: Create Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **"Add Project"**
3. Name it: `herstep-collection`
4. Enable or disable Google Analytics (your choice)
5. Click **Create Project**

### Step 2.2: Enable Authentication

1. In Firebase Console, go to **Authentication** > **Get Started**
2. Enable these sign-in methods:
   - **Email/Password** (required)
   - **Google** (recommended)
3. Add your authorized domains:
   - `localhost` (for development)
   - `your-project.vercel.app` (Vercel default)
   - `herstepcollection.co.ke` (if custom domain)

### Step 2.3: Create Firestore Database

1. Go to **Firestore Database** > **Create Database**
2. Choose **Start in production mode**
3. Select location: `eur3 (europe-west)` or nearest to Kenya
4. Click **Enable**

### Step 2.4: Set Security Rules

Replace the default Firestore rules with the rules in `firebase/firestore.rules` (included in this project).

1. Go to **Firestore Database** > **Rules** tab
2. Paste the contents of `firebase/firestore.rules`
3. Click **Publish**

### Step 2.5: Register Web App

1. Go to **Project Settings** (gear icon)
2. Scroll to **Your apps** section
3. Click the **Web icon** (</>)
4. Register app name: `herstep-web`
5. Copy the Firebase config object — you will need it for environment variables

```javascript
// This is what you'll see:
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "herstep-collection.firebaseapp.com",
  projectId: "herstep-collection",
  storageBucket: "herstep-collection.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### Step 2.6: Create Admin User

After deployment, create the first admin user:

1. Go to **Authentication** > **Users** > **Add User**
2. Enter admin email and password
3. In Firestore, create a document in `users` collection:

```
Collection: users
Document ID: [the user's UID from Authentication]

Fields:
- name: "Admin User" (string)
- email: "admin@herstepcollection.com" (string)
- phone: "+254799021089" (string)
- role: "super_admin" (string)
- createdAt: [timestamp]
```

---

## 3. CLOUDINARY SETUP

### Step 3.1: Create Cloudinary Account

1. Go to [cloudinary.com](https://cloudinary.com) and sign up
2. From your dashboard, note:
   - **Cloud Name** (e.g., `herstep`)
   - **API Key** (found in Dashboard > Account Details)
   - **API Secret** (found in Dashboard > Account Details)

### Step 3.2: Create Upload Preset

1. Go to **Settings** (gear icon) > **Upload** tab
2. Scroll to **Upload presets**
3. Click **Add upload preset**
4. Configure:
   - **Signing Mode**: Unsigned (for client-side uploads)
   - **Folder**: `herstep/products`
   - **Allowed formats**: jpg, jpeg, png, webp, mp4
   - **Max file size**: 10 MB for images, 50 MB for videos
5. Save the preset name (e.g., `herstep_unsigned`)

### Step 3.3: Create Signed Upload Preset (for admin)

1. Create another preset:
   - **Signing Mode**: Signed
   - **Folder**: `herstep/admin`
   - This requires server-side signing for security

---

## 4. M-PESA PAYMENT PROVIDER SETUP

You need an STK Push API provider. Common options:

### Option A: Safaricom Daraja API (Direct)
- Register at [developer.safaricom.co.ke](https://developer.safaricom.co.ke)
- Requires: Paybill/Till number, Business Manager access
- More complex but full control

### Option B: Third-Party Provider (Recommended for quick start)
- Providers: IntaSend, Pesapal, Flutterwave, or similar
- Easier integration, handles M-Pesa complexity
- You get API keys and a callback URL

### Step 4.1: Configure Your Provider

Regardless of provider, you need:

1. **API Key / Consumer Key** — authenticates your requests
2. **API Secret / Consumer Secret** — signs your requests
3. **Shortcode / Paybill / Till Number** — your business M-Pesa number
4. **Passkey** (for Daraja) — provided after going live
5. **Callback URL** — where M-Pesa sends payment confirmations

### Step 4.2: Set Callback URL

Your callback URL will be:

```
https://your-domain.vercel.app/api/payment/callback
```

Or for Vercel default:

```
https://herstep-collection.vercel.app/api/payment/callback
```

---

## 5. BACKEND API FUNCTIONS

The project includes Vercel Serverless API functions in the `api/` directory:

```
api/
├── payment/
│   ├── initiate.js      — Triggers M-Pesa STK Push
│   └── callback.js      — Receives M-Pesa payment confirmation
├── orders/
│   └── create.js        — Creates order with server-side validation
├── upload/
│   └── sign.js          — Signs Cloudinary uploads
└── webhook/
    └── support.js       — WhatsApp AI webhook (future)
```

These functions handle:
- **Payment initiation** — sends STK Push to customer's phone
- **Payment callback** — receives and validates M-Pesa confirmation
- **Order creation** — validates stock, prices, and discounts server-side
- **Upload signing** — generates secure Cloudinary upload signatures

---

## 6. ENVIRONMENT VARIABLES

### Step 6.1: Local Development

1. Copy the example file:
```bash
cp .env.example .env.local
```

2. Fill in your actual values (see `.env.example` for all variables)

### Step 6.2: Vercel Environment Variables

1. Go to your Vercel project dashboard
2. Navigate to **Settings** > **Environment Variables**
3. Add each variable from `.env.example`
4. Select environments: Production, Preview, Development

**CRITICAL: Never commit real credentials to Git.**

---

## 7. VERCEL DEPLOYMENT

### Step 7.1: Push to GitHub

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Initial commit: HerStep Collection"

# Create GitHub repository and push
git remote add origin https://github.com/YOUR_USERNAME/herstep-collection.git
git push -u origin main
```

### Step 7.2: Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New Project"**
3. Import your GitHub repository: `herstep-collection`
4. Vercel auto-detects Vite — no configuration needed
5. Add all environment variables from Section 6
6. Click **Deploy**

### Step 7.3: Verify Deployment

After deployment:
1. Visit your Vercel URL (e.g., `https://herstep-collection.vercel.app`)
2. Test the homepage loads
3. Test product browsing
4. Test cart and checkout flow
5. Test admin login at `/admin`

---

## 8. CUSTOM DOMAIN (OPTIONAL)

### Step 8.1: Purchase Domain

Recommended registrars for Kenya:
- [Safaricom domains](https://domains.safaricom.co.ke)
- [Kenic](https://kenic.co.ke) (.co.ke domains)
- [Namecheap](https://namecheap.com)

### Step 8.2: Connect to Vercel

1. In Vercel project: **Settings** > **Domains**
2. Add your domain: `herstepcollection.co.ke`
3. Vercel provides DNS records to add:
   - **A Record** pointing to Vercel's IP
   - **CNAME** for `www` subdomain
4. Add these records at your domain registrar
5. Wait for DNS propagation (up to 48 hours)
6. SSL certificate is automatically provisioned by Vercel

---

## 9. POST-LAUNCH CHECKLIST

### Functionality Tests

- [ ] Register a new customer account
- [ ] Browse products and use filters
- [ ] Add items to cart
- [ ] Complete checkout with M-Pesa STK Push (use test amount)
- [ ] Verify payment callback updates order status
- [ ] View order receipt
- [ ] Track order status
- [ ] Create support ticket and test real-time chat
- [ ] Test admin dashboard (login as admin)
- [ ] Verify admin can change order status
- [ ] Verify admin can add/edit products
- [ ] Test promo code application
- [ ] Test mobile responsiveness on actual phone

### Security Checks

- [ ] Verify Firestore security rules are published
- [ ] Verify no API secrets in frontend code
- [ ] Test that customers cannot access admin routes
- [ ] Test that customers cannot see other customers' data
- [ ] Verify payment callback validates signatures
- [ ] Test concurrent purchase scenario (race condition)

### Business Checks

- [ ] All product prices are correct
- [ ] All product images are loaded from Cloudinary
- [ ] Delivery fees are configured correctly
- [ ] Business contact details are accurate
- [ ] Store location is correct
- [ ] WhatsApp link works
- [ ] M-Pesa payment shortcode is correct

### Performance Checks

- [ ] Homepage loads in under 3 seconds
- [ ] Product images are optimized via Cloudinary
- [ ] No console errors in browser
- [ ] Mobile layout works on Android and iOS
- [ ] All links and navigation work

---

## 10. ONGOING MAINTENANCE

### Daily
- Check for new orders
- Respond to support tickets
- Process and ship orders

### Weekly
- Review sales analytics
- Update product inventory
- Check for low stock items
- Review support ticket resolution times

### Monthly
- Update product catalog (new arrivals)
- Review and update promotions
- Check Firebase usage (may need to upgrade plan)
- Review Cloudinary usage
- Backup Firestore data (Firebase has automated backups)
- Update dependencies (`npm update`)

### Quarterly
- Review and rotate API keys
- Audit admin access logs
- Review and update security rules
- Performance optimization review
- Customer feedback review

---

## COST ESTIMATES (Monthly)

| Service | Free Tier | Expected Cost |
|---------|-----------|---------------|
| Vercel | Hobby (free) | Free - $20/mo (Pro) |
| Firebase | Spark (free) | Free - $25/mo (Blaze) |
| Cloudinary | Free tier | Free - $89/mo |
| Domain | N/A | ~KSh 1,000-3,000/year |
| M-Pesa API | Varies | Transaction fees |

**For starting out, you can run entirely on free tiers.**

Firebase free tier includes:
- 50,000 reads/day
- 20,000 writes/day
- 1 GB storage
- 1 GB/month network egress

Cloudinary free tier includes:
- 25 GB storage
- 25 GB bandwidth/month
- 25 monthly credits

---

## TROUBLESHOOTING

### "Page not found" on refresh
- Add `vercel.json` rewrites (included in project)

### M-Pesa STK Push not working
- Verify API credentials in environment variables
- Check callback URL is accessible (not blocked by firewall)
- Verify shortcode/Paybill is active
- Test with small amount first

### Firebase permission errors
- Check Firestore security rules are published
- Verify user is authenticated
- Check user role in Firestore `users` collection

### Images not loading
- Verify Cloudinary cloud name is correct
- Check upload preset exists and is configured
- Verify images were uploaded successfully

---

## SUPPORT

For deployment issues:
- Vercel docs: [vercel.com/docs](https://vercel.com/docs)
- Firebase docs: [firebase.google.com/docs](https://firebase.google.com/docs)
- Cloudinary docs: [cloudinary.com/documentation](https://cloudinary.com/documentation)

For business support:
- Email: herstepcollection@gmail.com
- Phone: +254 799 021 089
- WhatsApp: +254 106 624 924
