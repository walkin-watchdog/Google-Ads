import { describe, expect, test } from 'bun:test';
import {
    cpaBenchmarkForAccount,
    currencyCodeFromAccountRow,
    defaultCpaBenchmarkForCurrency
} from '../lib/accountBenchmarks.ts';

describe('account CPA benchmarks', () => {
    test('reads flat dashboard account currency rows', () => {
        expect(currencyCodeFromAccountRow({ 'customer.currency_code': 'usd' })).toBe('USD');
    });

    test('reads normalized deterministic account currency rows', () => {
        expect(currencyCodeFromAccountRow({ customer: { currencyCode: 'eur' } })).toBe('EUR');
    });

    test('uses low-unit fallback for USD-style currencies and INR fallback otherwise', () => {
        expect(defaultCpaBenchmarkForCurrency('USD')).toBe(25);
        expect(defaultCpaBenchmarkForCurrency('INR')).toBe(2000);
    });

    test('positive account CPA overrides currency fallback', () => {
        expect(cpaBenchmarkForAccount(123, 'USD')).toBe(123);
        expect(cpaBenchmarkForAccount(0, 'USD')).toBe(25);
    });
});
