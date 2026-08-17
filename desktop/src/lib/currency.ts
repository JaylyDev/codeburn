/// Currency formatting that mirrors the macOS app's Double.asCurrency / asCompactCurrency.
/// The Rust backend hands us { code, symbol, rate } so the frontend stays dumb about FX --
/// it just multiplies and renders.

export type CurrencyState = {
  code: string
  symbol: string
  rate: number
}

export const USD: CurrencyState = { code: 'USD', symbol: '$', rate: 1 }

export const CURRENCY_CODES = [
  'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'NZD', 'JPY', 'CHF', 'INR',
  'BRL', 'SEK', 'SGD', 'HKD', 'KRW', 'MXN', 'ZAR', 'DKK',
] as const

const SUB_CENT = 0.005

/// Wider format with thousands separators. Used for the hero value.
export function formatCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  const parts = converted.toFixed(2).split('.')
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${currency.symbol}${whole}.${parts[1]}`
}

/// Compact form (no thousands separators) used in dense tables where the monospace font
/// already gives visual grouping.
export function formatCompactCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  return `${currency.symbol}${converted.toFixed(2)}`
}

/// For savings and other tiny amounts: never print a misleading "$0.00".
export function formatSmallCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  if (converted > 0 && converted < SUB_CENT) return `<${currency.symbol}0.01`
  return formatCompactCurrency(usdAmount, currency)
}

/// Token compaction shared by every surface (the mac app rounds K to whole numbers).
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${Math.round(n)}`
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}
