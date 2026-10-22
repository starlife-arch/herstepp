/**
 * PrintPay B2C adapter foundation.
 *
 * IMPORTANT: This module is intentionally not wired into seller payout routes.
 * PrintPay's documented "initialized successfully" response is not proof of
 * final M-Pesa delivery. Do not post a seller-ledger debit or mark PAID from it.
 * Wire this into the payout flow only after PrintPay confirms authenticated
 * result callbacks or a transaction-status endpoint and a reliable fee quote.
 */
const PRINTPAY_WITHDRAW_URL = 'https://printpay.site/b2c/payout/withdraw';

const clean = (value, max = 180) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/[\\s()-]/g, '');
  if (/^07\\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^01\\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^254[17]\\d{8}$/.test(digits)) return digits;
  if (/^\\+254[17]\\d{8}$/.test(digits)) return digits.slice(1);
  throw new Error('Enter a valid Kenyan M-Pesa phone number.');
}

/**
 * Initiates a PrintPay B2C transfer. Calling this function can move real money.
 * It is deliberately not called anywhere in the current payout routes.
 *
 * Required server-side environment variables:
 * PRINTPAY_WALLET_ID
 * PRINTPAY_SECURITY_CREDENTIAL
 * PRINTPAY_B2C_PIN
 */
export async function initiatePrintPayB2CPayout({
  payoutId,
  phone,
  amount,
  remarks = 'Herstepp seller payout',
  occasion = 'Marketplace seller payout',
}) {
  if (!clean(payoutId, 180)) throw new Error('A stable payout ID is required.');
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error('Payout amount must be a positive whole KSh amount.');
  }

  const walletId = clean(process.env.PRINTPAY_WALLET_ID, 300);
  const securityCredential = clean(process.env.PRINTPAY_SECURITY_CREDENTIAL, 1000);
  const pin = clean(process.env.PRINTPAY_B2C_PIN, 100);
  if (!walletId || !securityCredential || !pin) {
    throw new Error('PrintPay B2C credentials are not fully configured on the server.');
  }

  const response = await fetch(PRINTPAY_WITHDRAW_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wallet-ID': walletId,
      'X-Security-Credential': securityCredential,
    },
    body: JSON.stringify({
      command_id: 'BusinessPayment',
      phone: normalizeKenyanPhone(phone),
      amount,
      pin,
      remarks: clean(remarks, 100),
      occasion: clean(occasion, 100),
    }),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('PrintPay returned a non-JSON response; payout outcome is unknown. Do not retry automatically.');
  }

  if (!response.ok || String(body?.status || '').toLowerCase() !== 'success') {
    const error = new Error('PrintPay did not confirm payout initialization. Check the provider record before retrying.');
    error.providerHttpStatus = response.status;
    error.providerMessage = clean(body?.message, 300);
    throw error;
  }

  // This means initiation was accepted only. It must not be treated as PAID.
  return {
    payoutId: clean(payoutId, 180),
    providerStatus: 'INITIALIZED',
    finalStatusVerified: false,
    providerMessage: clean(body?.message, 300),
    // Keep the raw response out of logs and seller-visible output; it may
    // contain provider details. Store only reviewed, necessary fields later.
  };
}
