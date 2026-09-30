// PrintPay M-Pesa provider. createPrintPayProvider() is dependency-injectable
// (fetchImpl) so tests can fake the network; getMpesaProvider() reads env vars
// lazily on every call — never at module load, so a missing key surfaces as a
// clean 503 from the route instead of crashing the whole function bundle.
import { clientError } from './http.js';

const BASE_URL = 'https://printpay.site/api';

function providerError(message) {
  return clientError(message, 502);
}

export function createPrintPayProvider({ apiKey = process.env.PRINTPAY_API_KEY, baseUrl = process.env.PRINTPAY_API_BASE_URL || BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw clientError('M-Pesa payments are not configured yet. Please contact HerStep Collection.', 503);
  const base = baseUrl.replace(/\/+$/, '');
  async function postForm(url, params) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    } catch {
      throw providerError('The payment provider could not be reached.');
    }
    if (!response.ok) throw providerError('The payment provider rejected the request.');
    return response.json().catch(() => ({}));
  }
  async function getJson(url) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch {
      throw providerError('The payment provider could not be reached.');
    }
    if (!response.ok) throw providerError('The payment provider rejected the request.');
    return response.json().catch(() => ({}));
  }
  // Normalise a PrintPay STK payload into our internal payment status enum.
  function mapStatus(body) {
    const code = String(body.result_code ?? body.ResultCode ?? '');
    const text = String(body.status ?? body.Status ?? '').toUpperCase();
    if (code === '0' || text === 'SUCCESS') return 'PAID';
    if (code === '1032' || text === 'CANCELLED' || text === 'CANCELLED BY USER' || text.includes('USER CANCEL')) return 'CANCELLED';
    if (code === '1037' || text === 'TIMEOUT' || text === 'EXPIRED') return 'TIMEOUT';
    if (text === 'PENDING' || text === '' || code === '') return 'PENDING';
    return 'FAILED';
  }
  return {
    async initiateStk({ phone, amount }) {
      const body = await postForm(`${base}/stk_push`, { x_api_key: apiKey, phone_number: String(phone).replace(/^\+/, ''), amount: String(amount) });
      if (String(body.status ?? body.Status ?? '').toLowerCase() !== 'success' || !body.checkout_id) {
        throw providerError('PrintPay did not accept the payment request.');
      }
      return { providerReference: String(body.checkout_id).trim() };
    },
    async checkStatus(id) {
      const b = await getJson(`${base}/stk_push?${new URLSearchParams({ x_api_key: apiKey, check_status: String(id) })}`);
      const status = mapStatus(b);
      return {
        providerReference: String(b.checkout_id ?? id).trim(),
        status,
        amount: b.amount == null ? null : Number(b.amount),
        transactionReference: b.mpesa_receipt_number || b.mpesa_receipt || null,
        eventId: `status:${id}:${b.mpesa_receipt_number || b.mpesa_receipt || status}`,
      };
    },
    // Only a HINT — routes must re-confirm PAID with checkStatus() before applying it.
    async verifyCallback(req) {
      const b = req.body || {};
      const checkoutId = String(b.checkout_id ?? b.CheckoutID ?? '').trim();
      if (!checkoutId) return { providerReference: '', status: 'PENDING', amount: null, transactionReference: null, eventId: '' };
      const status = mapStatus(b);
      return {
        providerReference: checkoutId,
        status,
        amount: b.amount == null ? null : Number(b.amount),
        transactionReference: b.mpesa_receipt || b.mpesa_receipt_number || null,
        eventId: `callback:${checkoutId}:${b.result_code ?? b.status ?? status}`,
      };
    },
  };
}

export function getMpesaProvider() {
  return createPrintPayProvider({ apiKey: process.env.PRINTPAY_API_KEY?.trim() });
}
