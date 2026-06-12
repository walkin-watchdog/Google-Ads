import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dir, '..');

describe('public dashboard auth pages', () => {
    test('CSP allows same-origin login, forgot-password, and reset fetches', () => {
        const auth = fs.readFileSync(path.join(root, 'lib', 'dashboardAuth.ts'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(auth).toContain("connect-src 'self'");
        expect(server).toContain('async function zenseeoAuthFetch');
        expect(server).toContain("window.ZenseeoOffline?.pendingLogoutBlocked?.()");
        expect(server).toContain("zenseeoAuthFetch('/auth/login'");
        expect(server).toContain("zenseeoAuthFetch('/auth/forgot-password'");
        expect(server).toContain("zenseeoAuthFetch('/auth/reset'");
    });

    test('forgot-password uses a dedicated accessible form instead of a prompt', () => {
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(server).toContain("app.get('/forgot-password'");
        expect(server).toContain('id="forgotForm"');
        expect(server).toContain('id="emailFeedback"');
        expect(server).toContain('form.reportValidity()');
        expect(server).toContain('href="/forgot-password"');
        expect(server).not.toContain("prompt('Enter your dashboard email:')");
    });

    test('password setup exposes policy, strength, matching, and inline validation', () => {
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(server).toContain('id="strengthTrack"');
        expect(server).toContain('id="passwordRequirements"');
        expect(server).toContain('12–200 characters');
        expect(server).toContain('At least one letter');
        expect(server).toContain('At least one number');
        expect(server).toContain("confirmFeedback.textContent = !confirmValue ? 'Re-enter the same password.' : matches ? 'Passwords match.' : 'Passwords do not match.'");
        expect(server).toContain('saveButton.disabled = !(validation.valid && matches)');
        expect(server).toContain("maxlength=\"200\"");
        expect(server).toContain('id="resetSuccess"');
        expect(server).toContain('form.hidden = true');
        expect(server).toContain('href="/forgot-password">Request a new link');
    });
});
