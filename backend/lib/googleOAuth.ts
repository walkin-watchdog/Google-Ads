export interface GoogleAccessTokenOptions {
    refreshToken?: string;
}

function firstEnv(...names: string[]): string {
    for (const name of names) {
        const value = process.env[name];
        if (value && value.trim()) return value.trim();
    }
    return '';
}

export function getGoogleClientId(): string {
    return firstEnv('GOOGLE_CLIENT_ID', 'GOOGLE_ADS_CLIENT_ID');
}

export function getGoogleClientSecret(): string {
    return firstEnv('GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_CLIENT_SECRET');
}

export function getGoogleRefreshToken(options: GoogleAccessTokenOptions = {}): string {
    return options.refreshToken || firstEnv('GOOGLE_REFRESH_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN');
}

export async function getGoogleAccessToken(options: GoogleAccessTokenOptions = {}): Promise<string> {
    const clientId = getGoogleClientId();
    const clientSecret = getGoogleClientSecret();
    const refreshToken = getGoogleRefreshToken(options);

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Missing Google OAuth credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN or Google Ads equivalents.');
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });

    const data = await res.json().catch(() => null) as any;
    if (!res.ok || !data?.access_token) {
        throw new Error(`Failed to get Google OAuth access token: ${JSON.stringify(data)}`);
    }
    return data.access_token;
}
