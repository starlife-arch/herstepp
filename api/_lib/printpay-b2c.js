/**
 * PrintPay B2C API adapter.
 *
 * The documented withdraw response confirms initiation only. It is not proof
 * of final M-Pesa delivery. Do not mark a payout PAID from this response.
 *
 * Required server-side environment variables:
 * PRINTPAY_WALLET_ID
 * PRINTPAY_SECURITY_CREDENTIAL
 * PRINTPAY_B2C_PIN
 */
const PRINTPAY_BASE_URL = 'https://printpay.site/b2c';
const REQUEST_TIMEOUT_MS = 15_000;

const clean = (value, max = 180) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/[\s()-]/g, '');
  if (/^07\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^01\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits.slice(1);
  throw new Error('Enter a valid Kenyan M-Pesa phone number.');
}

function credentials(requirePin = false) {
  const walletId = clean(process.env.PRINTPAY_WALLET_ID, 300);
  const securityCredential = clean(process.env.PRINTPAY_SECURITY_CREDENTIAL, 1000);
  const pin = clean(process.env.PRINTPAY_B2C_PIN, 100);
  if (!walletId || !securityCredential || (requirePin && !pin)) {
    throw new Error('PrintPay B2C credentials are not fully configured on the server.');
  }
  return { walletId, securityCredential, pin };
}

async function post(path, body) {
  const { walletId, securityCredential } = credentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(PRINTPAY_BASE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-ID': walletId,
        'X-Security-Credential': securityCredential,
      },
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    // Especially for a withdrawal, a network error or timeout is an unknown
    // outcome: the provider may have accepted the request before the response
    // was lost. Callers must reconcile with PrintPay, never blindly retry.
    const error = new Error('PrintPay connection failed or timed out. The operation outcome may be unknown; reconcile with PrintPay before retrying.');
    error.outcomeUnknown = true;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error('PrintPay returned a non-JSON response. The operation outcome may be unknown.');
    error.providerHttpStatus = response.status;
    error.outcomeUnknown = true;
    throw error;
  }
  if (!response.ok || String(data?.status || '').toLowerCase() !== 'success') {
    const error = new Error('PrintPay request was not accepted. Check the provider dashboard before retrying.');
    error.providerHttpStatus = response.status;
    error.providerMessage = clean(data?.message, 300);
    throw error;
  }
  return data;
}

/** Reads the live PrintPay B2C wallet balance. */
export async function getPrintPayB2CWalletBalance() {
  const data = await post('/walletbalance');
  const balance = Number(data?.balance);
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error('PrintPay returned an invalid wallet balance.');
  }
  return {
    walletId: clean(data?.wallet_id, 300),
    balance,
    currency: 'KES',
  };
}

/**
 * Initiates a real B2C transfer. Do not call this until the payout has been
 * approved and a durable payout record is locked against concurrent dispatch.
 * A successful result here means INITIALIZED, never PAID.
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
  const { pin } = credentials(true);
  const data = await post('/payout/withdraw', {
    command_id: 'BusinessPayment',
    phone: normalizeKenyanPhone(phone),
    amount,
    pin,
    remarks: clean(remarks, 100),
    occasion: clean(occasion, 100),
  });

  // The example response includes the provider's dynamic fee. Parse it when
  // present, but never invent a fee if the message format differs.
  const message = clean(data?.message, 500);
  const amounts = message.match(/Deducted\s+KES\s+([\d,]+)\s*\(\s*Amount:\s*KES\s+([\d,]+)\s*\+\s*Fee:\s*KES\s+([\d,]+)/i);
  const parseKes = value => Number(String(value).replace(/,/g, ''));
  const reportedTotalDebit = amounts ? parseKes(amounts[1]) : null;
  const reportedAmount = amounts ? parseKes(amounts[2]) : null;
  const reportedFee = amounts ? parseKes(amounts[3]) : null;
  const feeBreakdownValid = amounts
    && Number.isSafeInteger(reportedTotalDebit)
    && Number.isSafeInteger(reportedAmount)
    && Number.isSafeInteger(reportedFee)
    && reportedTotalDebit === reportedAmount + reportedFee
    && reportedAmount === amount;

  return {
    payoutId: clean(payoutId, 180),
    providerStatus: 'INITIALIZED',
    finalStatusVerified: false,
    providerMessage: message,
    requestedAmount: amount,
    feeBreakdown: feeBreakdownValid
      ? { amount: reportedAmount, fee: reportedFee, totalDebit: reportedTotalDebit }
      : null,
  };
}

/** Sends a real STK Push payment prompt; it does not debit the wallet. */
export async function initiatePrintPayB2CTopup({ phone, amount }) {
  if (!Number.isSafeInteger(amount) || amount < 10 || amount > 10_000_000) {
    throw new Error('PrintPay top up amount must be a whole KSh amount of at least 10.');
  }
  // PrintPay's STK endpoint example uses the local 07XXXXXXXX phone format.
  const digits = String(phone || '').replace(/[\\s()-]/g, '');
  const localPhone = /^\\+?254[17]\\d{8}$/.test(digits)
    ? '0' + digits.replace(/^\\+?254/, '')
    : digits;
  if (!/^(07|01)\\d{8}$/.test(localPhone)) {
    throw new Error('Enter a valid Kenyan M-Pesa phone number.');
  }
  const data = await post('/topup/stk_push', { phone: localPhone, amount });
  return { providerStatus: 'INITIALIZED', providerMessage: clean(data?.message || 'PrintPay accepted the STK Push request.', 300) };
}
