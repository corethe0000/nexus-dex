//amounts are kept as integers of the smallest unit; these turn them into text and back. Amounts keep one number
//format in every language (decimal point, what the amount fields read back); times and durations follow the language
import { T } from './i18n';

export function toUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') {
    return null;
  }
  const [whole = '0', frac = ''] = t.split('.');
  if (frac.length > decimals) {
    return null;
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function fromUnits(v: bigint | string, decimals: number, maxFraction = decimals): string {
  const n = typeof v === 'string' ? BigInt(v) : v;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = (a / base).toLocaleString('en-US');
  let frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  if (decimals === 0) {
    frac = '';
  }
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

//price of 1 Nexus coin in the EVM token, as a decimal string
export function price(nexusAmount: bigint, nexusDecimals: number, evmAmount: bigint, evmDecimals: number, digits = 4): string {
  if (nexusAmount === 0n) {
    return '-';
  }
  const scaled = (evmAmount * 10n ** BigInt(nexusDecimals) * 10n ** BigInt(digits)) / (nexusAmount * 10n ** BigInt(evmDecimals));
  return fromUnits(scaled, digits, digits);
}

export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);

export function clock(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(T().lang, { hour: '2-digit', minute: '2-digit' });
}

export function span(seconds: number): string {
  const { t, f } = T();
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) {
    return f(t.spanSeconds, { n: s });
  }
  if (s < 5400) {
    return f(t.spanMinutes, { n: Math.round(s / 60) });
  }
  return f(t.spanHours, { n: (s / 3600).toFixed(s < 36000 ? 1 : 0) });
}
