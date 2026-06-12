import { describe, expect, test } from 'bun:test';
import { normalizeSmtpPassword } from '../lib/email.ts';

describe('SMTP password normalization', () => {
    test('removes display whitespace from a grouped Gmail App Password', () => {
        expect(normalizeSmtpPassword('smtp.gmail.com', 'abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
        expect(normalizeSmtpPassword(' SMTP.GMAIL.COM ', 'abcd\tefgh\nijkl  mnop')).toBe('abcdefghijklmnop');
    });

    test('does not alter other SMTP passwords or non-App-Password Gmail values', () => {
        expect(normalizeSmtpPassword('smtp.example.com', 'abcd efgh ijkl mnop')).toBe('abcd efgh ijkl mnop');
        expect(normalizeSmtpPassword('smtp.gmail.com', 'ordinary password with spaces')).toBe('ordinary password with spaces');
    });
});
