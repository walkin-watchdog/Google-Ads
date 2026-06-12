const LOW_UNIT_CPA_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);

export function currencyCodeFromAccountRow(row: any, fallback = 'INR'): string {
    const value = row?.['customer.currency_code']
        ?? row?.customer?.currencyCode
        ?? row?.customer?.currency_code
        ?? row?.currency
        ?? fallback;
    const text = String(value || fallback).trim().toUpperCase();
    return text || fallback;
}

export function defaultCpaBenchmarkForCurrency(currency: any): number {
    const code = String(currency || '').trim().toUpperCase();
    return LOW_UNIT_CPA_CURRENCIES.has(code) ? 25 : 2000;
}

export function cpaBenchmarkForAccount(accountCpa: any, currency: any): number {
    const cpa = Number(accountCpa || 0);
    return cpa > 0 ? cpa : defaultCpaBenchmarkForCurrency(currency);
}
