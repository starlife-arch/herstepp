# HerStep Collection: project rules

This repo (Vite + React + TypeScript UI, Vercel serverless API in /api) is the NEW main site. It must run against the SAME Firebase project as my current live site (projectId herstep-collection), so the Firestore data model below is a fixed contract. Never rename fields, collections, or roles. Keep the existing UI and design; do not redesign pages.

## Non-negotiables
- No secrets in the repo or browser code. Ever. No hardcoded keys.
- No fake payment confirmation. An order becomes PAID only via server-verified PrintPay data.
- Browser never writes orders, payments, inventory, roles or prices. Only token-verified /api functions (Firebase Admin) do.
- Prices, discounts, delivery fees and totals are always recomputed on the server from Firestore.
- Never weaken Firestore rules. No unnecessary new frameworks. Delete mock data and fake auth when replaced.
- Money is integer KES. Phones are stored as +2547XXXXXXXX or +2541XXXXXXXX.
- Vercel Hobby plan has a function limit, so /api uses ONE file per area (admin.js, catalog.js, orders.js, users.js, payments.js) that dispatches by ?route=... to lazily imported modules in api/_lib/routes/. vercel.json rewrites /api/<path> to /api/<area>?route=<name>.
- Server env vars (set in Vercel only): FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID (public web config, served to the browser by GET /api/firebase-config at runtime), FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, PRINTPAY_API_KEY, PRINTPAY_API_BASE_URL (default https://printpay.site/api). No VITE_ variables are needed for these.

## Data contract (Firestore)
- users/{uid}: uid, email, displayName, phoneNumber, deliveryDetails, marketingConsent(bool), role ("CUSTOMER" | "ADMIN" | "SUPER_ADMIN", UPPERCASE), createdAt, updatedAt. Browser can only create its own doc with role CUSTOMER; roles are changed only by a trusted script.
- products/{id}: name, description, categoryId, sku(UPPERCASE), price(int), salePrice(int|null, must be < price), inventory: [{size:"36", quantity:int}] where size is a STRING "30".."45" and unique, images: [{url, publicId, resourceType:"image"}] (1 to 8), video: {url, publicId, resourceType:"video"}|null, status ("DRAFT"|"ACTIVE"|"ARCHIVED"), featured, bestseller, newArrival (bools), stockQuantity (derived sum), availableSizes (derived: sizes with quantity>0). Derived fields are written only by the server. Public catalogue shows status ACTIVE only.
- categories/{id}: public read, server write.
- orders/{id}: orderId ("HS-YYYY-000001", from orderCounters/{year}.sequence), customerId, customerEmail, items:[{productId,name,sku,categoryId,size,quantity,unitPrice,lineTotal,imageUrl}], subtotal, deliveryFee, discount, promoCode, total, currency "KES", paymentStatus ("PENDING"|"PAID"|"FAILED"|"CANCELLED"|"TIMEOUT"|"REFUNDED"), orderStatus ("PENDING"|"PROCESSING"|"PROCESSED"|"OUT_FOR_DELIVERY"|"DELIVERED"|"CANCELLED"), inventoryReserved(bool), delivery:{fullName,phone,deliveryMethod:"COLLECTION"|"DELIVERY",location,instructions}, activePaymentId, paymentId, paymentReference, createdAt, updatedAt.
- payments/{id}: paymentId, receiptNumber ("HSP-<ID>" only when PAID), orderDocumentId, orderId, customerId, amount, currency, phone, method "MPESA", status (same values as paymentStatus), providerReference (PrintPay checkout_id), transactionReference (M-Pesa receipt), failureReason, createdAt, updatedAt, initiatedAt, completedAt.
- paymentTransactions/{base64url(eventId)}: idempotency record per provider event. orderStatusHistory/{id}: orderId, orderDocumentId, customerId, eventType, previousStatus, newStatus, paymentStatus, note, source, createdAt. notifications/{orderDocumentId-EVENT}: customerId, orderDocumentId, event, title, body, readAt(null), createdAt. inventoryLogs, auditLogs: server-only. settings/checkout: {deliveryEnabled:bool, deliveryRates:{outsideJuja:int(default 100), kiambu:int(200), defaultCounty:int(500), counties:{name:fee}}}. Collection pickup is always available at "Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12".
- Order status transitions allowed: PENDING->PROCESSING|CANCELLED, PROCESSING->PROCESSED|CANCELLED, PROCESSED->OUT_FOR_DELIVERY|CANCELLED, OUT_FOR_DELIVERY->DELIVERED. Payment transitions: PENDING->PAID|FAILED|CANCELLED|TIMEOUT, PAID->REFUNDED only.

===== APPEND TO AGENTS.md =====
## Phase 2 contract

### Definition of done (applies to every task)
- Every task covers BACKEND AND FRONTEND together. Never report "backend done, frontend pending". If something cannot be finished, finish whole vertical slices and say precisely what is missing.
- Whenever an API response shape changes, update every frontend consumer and src/lib/apiTypes.ts in the same task.
- Do NOT add new files directly under /api (Vercel Hobby limit is 12 functions). Register new routes in the existing area files (admin.js, catalog.js, orders.js, users.js, payments.js) and add a vercel.json rewrite for each. Keep sorting in memory and use single-field equality queries; do not depend on composite indexes.
- End every task with a table: Feature | backend | frontend | tested, with real status, plus pasted output of npm test, npm run check-api, npm run typecheck, npm run build.

### Env (server only, set in Vercel)
BREVO_API_KEY, BREVO_SENDER_HELLO, BREVO_SENDER_SUPPORT, BREVO_SENDER_ORDERS, BREVO_SENDER_PAYMENTS, BREVO_SENDER_PROMOTIONS, BREVO_SENDER_NAME, BREVO_REPLY_TO_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SITE_URL (public base URL for email links, default https://herstepp.vercel.app). Add all to .env.example.

### Side effects
Email and Telegram are best-effort: they must NEVER block or fail checkout, payments, signup or support. Send after the Firestore commit, using waitUntil from '@vercel/functions' (add the dependency), wrapped in try/catch. Email uses a transactional outbox: emailOutbox/{emailId(key)} = {key, purpose (hello|support|orders|payments|promotions), to, subject, htmlContent, status PENDING|SENDING|SENT, createdAt, sentAt, lastError}; deterministic keys make retries safe (an existing key means already queued).

### Collections (shared with the old live site; never rename fields)
- settings/checkout: {deliveryEnabled:bool, deliveryRates:{outsideJuja:int, kiambu:int, defaultCounty:int, counties:{name:fee}}}
- settings/hero: {enabled:bool, slides:[1..8 of {title<=160, copy<=500, ctaLabel<=80, ctaUrl (starts with # or / or https://), media:{url (https), publicId, resourceType 'image'|'video'}, mobileMedia:{image only}|null, focalPoint (one of 'left top','center top','right top','left center','center center','right center','left bottom','center bottom','right bottom')}]}
- settings/announcement: {enabled:bool, message<=500, linkUrl (https), linkLabel<=80}
- promoCodes/{CODE}: {name 3..120, description<=600|null, active:bool, startsAt, endsAt (end after start), discountType 'PERCENTAGE'|'FIXED', discountValue int>=1 (<=100 for PERCENTAGE), productIds:[<=100 ids], categoryIds:[<=100 ids], minimumOrderValue int>=0, maximumUsage int>=1|null, perCustomerUsage int 1..100 (default 1), usageCount int, createdAt, updatedAt}. Code regex ^[A-Z0-9][A-Z0-9_-]{2,39}$ (uppercase). If productIds AND categoryIds are both empty the code applies to ALL products; otherwise only to lines whose productId is in productIds OR whose categoryId is in categoryIds.
- promoCodeUsages/{CODE_uid}: {code, customerId, usageCount, updatedAt}
- orders also hold: discount, promoCode, promotion:{code,name,discountType,discountValue}
- supportTickets/{id}: {ticketId 'SUP-000001' (counters/supportTickets.sequence), customerId, customerName, customerEmail, subject 3..140, category one of 'Order Issue'|'Payment Issue'|'Delivery Issue'|'Product Issue'|'Return/Exchange'|'General Enquiry'|'Other', orderDocumentId|null, status OPEN|IN_PROGRESS|WAITING_FOR_CUSTOMER|RESOLVED|CLOSED, lastMessage, lastMessageAt, lastMessageSenderRole CUSTOMER|ADMIN, hasUnreadAdminMessages (true = customer wrote and admin has not opened it), assignedTo?, createdAt, updatedAt}; subcollections messages/{clientMessageId} {senderId, senderName, senderRole CUSTOMER|ADMIN, body<=4000 (optional only when attachments exist), attachments:[{url, publicId, type:'image'}] max 3, createdAt}, history/{prev-next} {previousStatus,newStatus,adminId,adminName,createdAt}, internalNotes/{auto} {body<=4000, authorId, authorName, createdAt}. Allowed status moves: OPEN->any; IN_PROGRESS->WAITING_FOR_CUSTOMER|RESOLVED|CLOSED; WAITING_FOR_CUSTOMER->IN_PROGRESS|RESOLVED|CLOSED; RESOLVED->IN_PROGRESS|WAITING_FOR_CUSTOMER|CLOSED; CLOSED is final.
- notifications/{orderDocumentId-EVENT}: {customerId, orderDocumentId, event, title, body, readAt:null, createdAt}
- auditLogs (server only): {adminId, adminName, action, targetType, targetId, previous, next, createdAt}
The Firestore rules already cover these collections; never loosen them.
===== END =====
## UI FREEZE (standing rule)
- The existing pages' layout, markup, class names, spacing, copy and components are the approved design. Tasks change DATA WIRING only. Never rewrite, reorder, restyle or "simplify" a page. New screens that do not exist yet must be built with the same components (Card, Button, Badge, Input, EmptyState from src/components/ui) and the same Tailwind patterns used on neighbouring screens.
- Before editing any existing page, view the current file and make the smallest edit. A wholesale rewrite must keep the same JSX structure and classNames.
- Never write minified or one-line code. Use normal formatting (2 spaces, one statement per line).
- If a page was changed from the original design, restore the original markup from git history (git log --follow -p -- <file>) before wiring data.

- Never pass `text-` or `bg-` colour classes to `Button`; select the appropriate Button variant instead.
