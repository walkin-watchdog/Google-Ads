import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import crypto from 'crypto';

const DEFAULT_SEND_TIMEOUT_MS = 15_000;

export type MailSendResult = {
    messageId: string | null;
};

function requiredEnv(name: string): string {
    const value = String(process.env[name] || '').trim();
    if (!value) throw new Error(`${name} is required to send dashboard email.`);
    return value;
}

function smtpPort(): number {
    const value = Number(requiredEnv('SMTP_PORT'));
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error('SMTP_PORT must be a valid TCP port.');
    }
    return value;
}

function smtpSecure(): boolean {
    const raw = requiredEnv('SMTP_SECURE').toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new Error('SMTP_SECURE must be true or false.');
}

function sendTimeoutMs(): number {
    const value = Number(process.env.SMTP_TIMEOUT_MS || DEFAULT_SEND_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SEND_TIMEOUT_MS;
}

export function normalizeSmtpPassword(host: string, password: string): string {
    if (host.trim().toLowerCase() !== 'smtp.gmail.com') return password;
    const trimmed = password.trim();
    return /^\S{4}(?:\s+\S{4}){3}$/.test(trimmed)
        ? trimmed.replace(/\s+/g, '')
        : password;
}

function publicDashboardBaseUrl(): string {
    const value = requiredEnv('PUBLIC_DASHBOARD_BASE_URL').replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('PUBLIC_DASHBOARD_BASE_URL must be a valid absolute URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('PUBLIC_DASHBOARD_BASE_URL must be an absolute http(s) URL without credentials, query, or fragment.');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !loopback) {
        throw new Error('PUBLIC_DASHBOARD_BASE_URL must use HTTPS in production.');
    }
    return value;
}

function smtpOptions(): SMTPTransport.Options {
    const host = requiredEnv('SMTP_HOST');
    const user = requiredEnv('SMTP_USER');
    const pass = normalizeSmtpPassword(host, requiredEnv('SMTP_PASS'));
    return {
        host,
        port: smtpPort(),
        secure: smtpSecure(),
        auth: { user, pass },
        connectionTimeout: sendTimeoutMs(),
        greetingTimeout: sendTimeoutMs(),
        socketTimeout: sendTimeoutMs()
    };
}

let transport: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null = null;

function mailTransport(): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
    if (!transport) transport = nodemailer.createTransport(smtpOptions());
    return transport;
}

function dashboardResetUrl(token: string): string {
    const url = new URL('/auth/reset', `${publicDashboardBaseUrl()}/`);
    url.searchParams.set('token', token);
    return url.toString();
}

function emailFrom(): string {
    return requiredEnv('SMTP_FROM');
}

function emailReplyTo(): string | undefined {
    const value = String(process.env.SMTP_REPLY_TO || '').trim();
    return value || undefined;
}

function recipientHash(value: string): string {
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function safeMailError(value: unknown): string {
    return String(value || 'Dashboard email delivery failed.')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

async function sendDashboardMail(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
}): Promise<MailSendResult> {
    try {
        const info = await mailTransport().sendMail({
            from: emailFrom(),
            replyTo: emailReplyTo(),
            to: input.to,
            subject: input.subject,
            text: input.text,
            html: input.html
        });
        console.log('dashboard_email_sent', { recipientHash: recipientHash(input.to), subject: input.subject, messageId: info.messageId || null });
        return { messageId: info.messageId || null };
    } catch (err: any) {
        console.error('dashboard_email_failed', {
            recipientHash: recipientHash(input.to),
            subject: input.subject,
            error: safeMailError(err?.message || err)
        });
        throw new Error(safeMailError(err?.message || err));
    }
}

function paragraphHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char] || char));
}

export async function sendDashboardInviteEmail(input: { email: string; name: string; token: string }): Promise<MailSendResult> {
    const url = dashboardResetUrl(input.token);
    const subject = 'Set up your Zenseeo dashboard account';
    const text = [
        `Hi ${input.name},`,
        '',
        'You have been invited to the Zenseeo Google Ads dashboard.',
        `Set your password here: ${url}`,
        '',
        'This invitation expires in seven days. If you did not expect this email, ignore it.'
    ].join('\n');
    const safeName = paragraphHtml(input.name);
    const safeUrl = paragraphHtml(url);
    return sendDashboardMail({
        to: input.email,
        subject,
        text,
        html: `<p>Hi ${safeName},</p><p>You have been invited to the Zenseeo Google Ads dashboard.</p><p><a href="${safeUrl}">Set your password</a></p><p>This invitation expires in seven days.</p>`
    });
}

export async function sendDashboardPasswordResetEmail(input: { email: string; name: string; token: string }): Promise<MailSendResult> {
    const url = dashboardResetUrl(input.token);
    const subject = 'Reset your Zenseeo dashboard password';
    const text = [
        `Hi ${input.name},`,
        '',
        'A password reset was requested for your Zenseeo Google Ads dashboard account.',
        `Reset your password here: ${url}`,
        '',
        'This reset link expires in one hour. If you did not request it, ignore this email.'
    ].join('\n');
    const safeName = paragraphHtml(input.name);
    const safeUrl = paragraphHtml(url);
    return sendDashboardMail({
        to: input.email,
        subject,
        text,
        html: `<p>Hi ${safeName},</p><p>A password reset was requested for your Zenseeo Google Ads dashboard account.</p><p><a href="${safeUrl}">Reset your password</a></p><p>This reset link expires in one hour.</p>`
    });
}
