import { clientError } from './http.js';

export function normalizeKenyanPhone(value) {
  let number = String(value ?? '').replace(/[\s()\-]/g, '');

  if (number.startsWith('0')) {
    number = `254${number.slice(1)}`;
  }
  if (number.startsWith('+')) {
    number = number.slice(1);
  }

  if (!/^254[17]\d{8}$/.test(number)) {
    throw clientError('Enter a valid Kenyan phone number.');
  }

  return `+${number}`;
}
