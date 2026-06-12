import { getGoogleAccessToken } from './googleOAuth';

const DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS = 25_000;

function googleAdsFetchTimeoutMs(): number {
    const configured = Number(process.env.GOOGLE_ADS_FETCH_TIMEOUT_MS || DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 1_000 ? configured : DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS;
}

async function fetchGoogleAds(url: string, init: RequestInit = {}): Promise<Response> {
    const timeoutMs = googleAdsFetchTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            throw new Error(`Google Ads API request timed out after ${timeoutMs}ms. Narrow the GAQL date range, request fewer fields, or retry later.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

export const getAccessToken = async (): Promise<string> => {
    console.log('Fetching Google OAuth2 token...');
    return getGoogleAccessToken();
};

export const getAccessibleCustomer = async (token: string): Promise<string> => {
    if (process.env.GOOGLE_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID) {
        return (process.env.GOOGLE_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID) as string;
    }
    
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    const res = await fetchGoogleAds('https://googleads.googleapis.com/v24/customers:listAccessibleCustomers', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'developer-token': devToken
        }
    });
    const data = await res.json() as any;
    if (data.resourceNames && data.resourceNames.length > 0) {
        return data.resourceNames[0].split('/')[1]; // returns just the ID
    }
    throw new Error('No accessible customers found');
};

export const listAccessibleCustomers = async (token: string): Promise<any> => {
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    const res = await fetchGoogleAds('https://googleads.googleapis.com/v24/customers:listAccessibleCustomers', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'developer-token': devToken
        }
    });
    const data = await res.json() as any;
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data;
};

export const camelToSnake = (str: string): string => {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
};

export const flattenObject = (obj: any, prefix = ''): Record<string, any> => {
    let result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}.${camelToSnake(key)}` : camelToSnake(key);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(result, flattenObject(value, newKey));
        } else {
            if (typeof value === 'string' && newKey.startsWith('metrics.')) {
                result[newKey] = Number(value);
            } else {
                result[newKey] = value;
            }
        }
    }
    return result;
};

export const executeGaql = async (token: string, customerId: string, query: string): Promise<any[]> => {
    let allResults: any[] = [];
    let pageToken: string | undefined = undefined;
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    
    const loginCustomerId = process.env.GOOGLE_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    
    do {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'developer-token': devToken,
            'Content-Type': 'application/json'
        };
        if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

        const res = await fetchGoogleAds(`https://googleads.googleapis.com/v24/customers/${customerId}/googleAds:search`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(pageToken ? { query, pageToken } : { query })
        });
        
        let data: any;
        try {
            data = await res.json();
        } catch (e) {
            const text = await res.text().catch(() => 'No text');
            throw new Error(`Failed to parse JSON. Status: ${res.status}. Body: ${text}`);
        }
        
        if (data.error) throw new Error(JSON.stringify(data.error));
        if (data.results) {
            const flattenedResults = data.results.map((row: any) => flattenObject(row));
            allResults.push(...flattenedResults);
        }
        pageToken = data.nextPageToken;
    } while (pageToken);
    
    return allResults;
};

export const getResourceMetadata = async (token: string, query: string): Promise<any[]> => {
    let allResults: any[] = [];
    let pageToken: string | undefined = undefined;
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    
    const loginCustomerId = process.env.GOOGLE_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    
    do {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'developer-token': devToken,
            'Content-Type': 'application/json'
        };
        if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

        const res = await fetchGoogleAds(`https://googleads.googleapis.com/v24/googleAdsFields:search`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(pageToken ? { query, pageToken } : { query })
        });
        
        let data: any;
        try {
            data = await res.json();
        } catch (e) {
            const text = await res.text().catch(() => 'No text');
            throw new Error(`Failed to parse JSON. Status: ${res.status}. Body: ${text}`);
        }
        
        if (data.error) throw new Error(JSON.stringify(data.error));
        if (data.results) {
            allResults.push(...data.results);
        }
        pageToken = data.nextPageToken;
    } while (pageToken);
    
    return allResults;
};
