import { requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const CATEGORIES = ['Block Heels', 'Flats', 'Heels', 'Loafers', 'Platforms', 'Sandals', 'Slides'];
const SIZES = Array.from({ length: 16 }, (_, i) => String(30 + i));

export default async function analyzeBulkShoe(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  await requireAdmin(req);

  const imageUrl = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl.trim() : '';
  if (!imageUrl || imageUrl.length > 2048) throw clientError('Upload a product image first.');
  let parsed;
  try { parsed = new URL(imageUrl); } catch { throw clientError('The image URL is invalid.'); }
  if (parsed.protocol !== 'https:' || !/^(res\.cloudinary\.com|images\.unsplash\.com)$/i.test(parsed.hostname)) {
    throw clientError('Only securely hosted product images can be analysed.');
  }

  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw clientError('AI analysis is not configured yet. Add GROQ_API_KEY in Vercel project environment variables.', 503);
  const model = String(process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim();

  const prompt = `Inspect this real shoe product photo for a Kenyan ladies footwear shop. Return JSON only with keys: name, description, price, size, category, currency, priceConfidence, sizeConfidence. name: concise useful product name based only on visible design/colour. description: factual 1-2 sentence description of visible features; don't invent materials or benefits. price: whole-number price only if a clearly printed price is visible, otherwise null. size: one EU size as a string only if clearly printed, otherwise null. category must be exactly one of: ${CATEGORIES.join(', ')}; choose best fit. currency should be "KES" only if the image indicates Kenyan shillings/KSh, otherwise null. confidence values must be "high", "medium", or "low". Do not infer a size range from one visible size. Do not guess unclear numbers. If text is absent or ambiguous, use null for price/size and low confidence.`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(25000),
  }).catch(() => { throw clientError('The AI service could not be reached. Please try again.', 502); });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message;
    console.error('Groq shoe analysis failed:', response.status, detail || 'unknown error');
    throw clientError(response.status === 401 ? 'The Groq API key is invalid.' : 'AI analysis failed. Check your Groq model/key configuration and retry.', response.status === 429 ? 429 : 502);
  }
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw clientError('The AI returned no product details. Please enter them manually.', 502);
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let item;
  try { item = JSON.parse(jsonText); } catch { throw clientError('The AI response could not be read. Please retry or enter details manually.', 502); }

  const price = Number.isInteger(item.price) && item.price >= 0 && item.price <= 10000000 ? item.price : null;
  const size = SIZES.includes(String(item.size)) ? String(item.size) : null;
  const category = CATEGORIES.includes(item.category) ? item.category : 'Sandals';
  const confidence = v => ['high', 'medium', 'low'].includes(v) ? v : 'low';
  return res.status(200).json({
    name: typeof item.name === 'string' ? item.name.slice(0, 160) : '',
    description: typeof item.description === 'string' ? item.description.slice(0, 4000) : '',
    price,
    size,
    category,
    currency: item.currency === 'KES' ? 'KES' : null,
    priceConfidence: price === null ? 'low' : confidence(item.priceConfidence),
    sizeConfidence: size === null ? 'low' : confidence(item.sizeConfidence),
    needsReview: price === null || size === null || confidence(item.priceConfidence) !== 'high' || confidence(item.sizeConfidence) !== 'high',
  });
}
