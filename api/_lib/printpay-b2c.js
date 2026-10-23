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

// PrintPay's B2C documentation shows phones in the local 07XXXXXXXX / 01XXXXXXXX
// format, so send exactly that (not 2547XXXXXXXX or +2547XXXXXXXX).
function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/[\s()-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return digits;
  if (/^254[17]\d{8}$/.test(digits)) return '0' + digits.slice(3);
  if (/^\+254[17]\d{8}$/.test(digits)) return '0' + digits.slice(4);
  throw new Error('Enter a valid Kenyan M-Pesa phone number.');
}

// PrintPay rejects anything below KES 10 ("Invalid phone number or amount
// (Minimum KES 10)"). Check it here so the request is never sent.
export const MIN_B2C_AMOUNT = 10;
function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error('Amount must be a positive whole KSh amount.');
  }
  if (amount < MIN_B2C_AMOUNT) {
    const error = new Error(`The minimum amount is KSh ${MIN_B2C_AMOUNT}.`);
    error.code = 'BELOW_MINIMUM';
    throw error;
  }
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
    error.providerMessage = clean(data?.message || data?.error, 300);
    // Server log only (no secrets): lets you see PrintPay's exact reason in Vercel Logs.
    console.error(`[printpay-b2c] ${path} answered HTTP ${response.status}: ${error.providerMessage || '(no message)'}`);
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
  assertAmount(amount);
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
    // PrintPay's documented status-polling endpoint uses the conversation ID
    // returned by the withdrawal initiation response to find the transaction.
    providerConversationId: clean(data?.conversation_id, 180),
    providerStatus: 'INITIALIZED',
    finalStatusVerified: false,
    providerMessage: message,
    requestedAmount: amount,
    feeBreakdown: feeBreakdownValid
      ? { amount: reportedAmount, fee: reportedFee, totalDebit: reportedTotalDebit }
      : null,
  };
}

/**
 * Reads the final state of a previously initialized B2C payout.
 * PrintPay documents POST /payout/status and returns transaction_status,
 * result_desc and receipt. Only terminal states are returned to callers.
 */
export async function getPrintPayB2CPayoutStatus({ conversationId }) {
  const id = clean(conversationId, 180);
  if (!id) throw new Error('A PrintPay conversation ID is required to check payout status.');
  const data = await post('/payout/status', { conversation_id: id });
  const status = clean(data?.transaction_status, 40).toUpperCase();
  if (!['COMPLETED', 'FAILED', 'TIMED_OUT', 'REVERSED'].includes(status)) {
    return {
      providerConversationId: id,
      transactionStatus: status || 'PROCESSING',
      resultCode: data?.result_code ?? null,
      resultDescription: clean(data?.result_desc, 300),
      receipt: clean(data?.receipt, 80),
      terminal: false,
    };
  }
  return {
    providerConversationId: id,
    transactionStatus: status,
    resultCode: data?.result_code ?? null,
    resultDescription: clean(data?.result_desc, 300),
    receipt: clean(data?.receipt, 80),
    terminal: true,
  };
}

/** Sends a real STK Push payment prompt; it does not debit the wallet. */
export async function initiatePrintPayB2CTopup({ phone, amount }) {
  assertAmount(amount);
  const data = await post('/topup/stk_push', { phone: normalizeKenyanPhone(phone), amount });
  return { providerStatus: 'INITIALIZED', providerMessage: clean(data?.message || 'PrintPay accepted the STK Push request.', 300) };
}
