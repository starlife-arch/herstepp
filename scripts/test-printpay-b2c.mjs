import assert from 'node:assert/strict';

process.env.PRINTPAY_WALLET_ID = 'test-wallet';
process.env.PRINTPAY_SECURITY_CREDENTIAL = 'test-security-credential';
process.env.PRINTPAY_B2C_PIN = '4321';

const originalFetch = globalThis.fetch;
const calls = [];
try {
  const { getPrintPayB2CWalletBalance, initiatePrintPayB2CPayout, initiatePrintPayB2CTopup, MIN_B2C_AMOUNT } = await import('../api/_lib/printpay-b2c.js');
  assert.equal(MIN_B2C_AMOUNT, 10);

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: 'success', wallet_id: 'test-wallet', balance: 24500 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  assert.deepEqual(await getPrintPayB2CWalletBalance(), { walletId: 'test-wallet', balance: 24500, currency: 'KES' });
  assert.equal(calls[0].url, 'https://printpay.site/b2c/walletbalance');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-Wallet-ID'], 'test-wallet');
  assert.equal(calls[0].options.headers['X-Security-Credential'], 'test-security-credential');

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      status: 'success',
      message: 'Disbursement initialized successfully! Deducted KES 1,014 (Amount: KES 1,000 + Fee: KES 14).',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const payout = await initiatePrintPayB2CPayout({ payoutId: 'payout-test-123', phone: '0712345678', amount: 1000 });
  assert.equal(calls.at(-1).url, 'https://printpay.site/b2c/payout/withdraw');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    command_id: 'BusinessPayment',
    phone: '0712345678',
    amount: 1000,
    pin: '4321',
    remarks: 'Herstepp seller payout',
    occasion: 'Marketplace seller payout',
  });
  assert.equal(payout.providerStatus, 'INITIALIZED');
  assert.equal(payout.finalStatusVerified, false);
  assert.deepEqual(payout.feeBreakdown, { amount: 1000, fee: 14, totalDebit: 1014 });

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'success', message: 'Disbursement initialized successfully.' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const noFee = await initiatePrintPayB2CPayout({ payoutId: 'payout-test-456', phone: '+254112345678', amount: 50 });
  assert.equal(noFee.feeBreakdown, null);
  assert.equal(noFee.finalStatusVerified, false);


  // Amounts below KSh 10 must be rejected before any provider fetch for both
  // withdrawals and STK top-ups.
  for (const amount of [1, 9]) {
    const before = calls.length;
    await assert.rejects(
      initiatePrintPayB2CPayout({ payoutId: 'payout-min-' + amount, phone: '+254712345678', amount }),
      error => error.code === 'BELOW_MINIMUM' && error.message === 'The minimum amount is KSh 10.',
    );
    await assert.rejects(
      initiatePrintPayB2CTopup({ phone: '0712345678', amount }),
      error => error.code === 'BELOW_MINIMUM' && error.message === 'The minimum amount is KSh 10.',
    );
    assert.equal(calls.length, before, 'below-minimum requests must not fetch PrintPay');
  }

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ status: 'success', message: 'STK Push initialized' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  await initiatePrintPayB2CTopup({ phone: '+254740276456', amount: 10 });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { phone: '0740276456', amount: 10 });

  globalThis.fetch = async () => { throw new Error('simulated timeout'); };
  await assert.rejects(
    initiatePrintPayB2CPayout({ payoutId: 'payout-test-timeout', phone: '0712345678', amount: 100 }),
    error => error.outcomeUnknown === true && /reconcile with PrintPay/.test(error.message),
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'failed', message: 'Rejected' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(
    getPrintPayB2CWalletBalance(),
    /Check the provider dashboard before retrying/,
  );

  process.env.PRINTPAY_B2C_PIN = '';
  // Wallet-balance reads need wallet/security credentials, not the withdrawal PIN.
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'success', wallet_id: 'test-wallet', balance: 100 }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  assert.equal((await getPrintPayB2CWalletBalance()).balance, 100);
  await assert.rejects(
    initiatePrintPayB2CPayout({ payoutId: 'payout-test-no-pin', phone: '0712345678', amount: 100 }),
    /credentials are not fully configured/,
  );
  console.log('PrintPay B2C tests passed: wallet balance, auth headers, payout payload, Kenyan phone normalization, fee parsing, unknown outcomes, provider errors, and server-only credentials.');
} finally {
  globalThis.fetch = originalFetch;
}
