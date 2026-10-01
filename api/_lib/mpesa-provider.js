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
  // PrintPay's check_status reply has NO result_code at all — so an empty
  // result_code must NEVER mean PENDING when the status text says otherwise.
  // Rules, strictly in this order:
  //   code '0' or text SUCCESS                      -> PAID
  //   code '1032' or text containing CANCEL         -> CANCELLED
  //   code '1037'/'1036' or TIMEOUT/EXPIRED/TIMED   -> TIMEOUT
  //   text PENDING/PROCESSING/QUEUED, or BOTH empty -> PENDING
  //   anything else non-empty                       -> FAILED
  function mapStatus(body) {
    const code = String(body.result_code ?? body.ResultCode ?? '').trim();
    const text = String(body.status ?? body.Status ?? body.result_desc ?? body.ResultDesc ?? '').toUpperCase().trim();
    if (code === '0' || text === 'SUCCESS') return 'PAID';
    if (code === '1032' || text.includes('CANCEL')) return 'CANCELLED';
    // PrintPay keeps answering "pending" for a checkout the customer never
    // finished. Once M-Pesa itself says the STK push expired, the payment is
    // DEAD — map it to TIMEOUT immediately instead of leaving the order stuck
    // in PENDING until our 30-minute window elapses.
    if (code === '1037' || code === '1036' || text.includes('TIMEOUT') || text.includes('TIMED OUT') || text.includes('TIMED-OUT') || text.includes('EXPIRED')) return 'TIMEOUT';
    if (text === 'PENDING' || text === 'PROCESSING' || text === 'QUEUED') return 'PENDING';
    if (text === '' && code === '') return 'PENDING';
    return 'FAILED';
  }

  // Friendly human reason for a non-PAID outcome, stored as payments.failureReason.
  function failureReasonFor(body) {
    const code = String(body.result_code ?? body.ResultCode ?? '').trim();
    const text = String(body.status ?? body.Status ?? body.result_desc ?? body.ResultDesc ?? '').toUpperCase().trim();
    const status = mapStatus(body);
    if (status === 'PAID' || status === 'PENDING') return null;
    if (status === 'CANCELLED' || code === '1032') return 'You cancelled the M-Pesa request.';
    if (status === 'TIMEOUT' || code === '1037' || code === '1036') return 'The M-Pesa request timed out.';
    if (code === '2001' || text.includes('PIN')) return 'Wrong M-Pesa PIN entered.';
    if (code === '1' || text.includes('INSUFFICIENT') || text.includes('BALANCE')) return 'Insufficient M-Pesa balance.';
    return 'The payment was not completed.';
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
        reason: failureReasonFor(b),
      };
    },
    // Only a HINT — routes must re-confirm PAID with checkStatus() before applying it.
    async verifyCallback(req) {
      const b = req.body || {};
      const checkoutId = String(b.checkout_id ?? b.CheckoutID ?? '').trim();
      if (!checkoutId) return { providerReference: '', status: 'PENDING', amount: null, transactionReference: null, eventId: '', reason: null };
      const status = mapStatus(b);
      return {
        providerReference: checkoutId,
        status,
        amount: b.amount == null ? null : Number(b.amount),
        transactionReference: b.mpesa_receipt || b.mpesa_receipt_number || null,
        eventId: `callback:${checkoutId}:${b.result_code ?? b.status ?? status}`,
        reason: failureReasonFor(b),
      };
    },
  };
}

export function getMpesaProvider() {
  return createPrintPayProvider({ apiKey: process.env.PRINTPAY_API_KEY?.trim() });
}
