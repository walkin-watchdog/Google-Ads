import { getGoogleAccessToken } from './googleOAuth';
import {
    camelToSnake,
    executeGaqlRows,
    executeGaqlWithMetadata,
    flattenObject,
    requestGoogleAdsJson,
    type ExecuteGaqlOptions,
    type ExecuteGaqlResult
} from './googleAdsClient';

export { camelToSnake, flattenObject, executeGaqlWithMetadata };

export const getAccessToken = async (): Promise<string> => {
    console.log('Fetching Google OAuth2 token...');
    return getGoogleAccessToken();
};

export const getAccessibleCustomer = async (token: string): Promise<string> => {
    if (process.env.GOOGLE_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID) {
        return (process.env.GOOGLE_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID) as string;
    }

    const response = await requestGoogleAdsJson<any>({
        token,
        path: 'customers:listAccessibleCustomers',
        method: 'GET',
        retryMode: 'read'
    });
    if (response.data.resourceNames && response.data.resourceNames.length > 0) {
        return response.data.resourceNames[0].split('/')[1];
    }
    throw new Error('No accessible customers found');
};

export const listAccessibleCustomers = async (token: string): Promise<any> => {
    return (await requestGoogleAdsJson<any>({
        token,
        path: 'customers:listAccessibleCustomers',
        method: 'GET',
        retryMode: 'read'
    })).data;
};

export const executeGaql = async (
    token: string,
    customerId: string,
    query: string,
    options: ExecuteGaqlOptions = {}
): Promise<any[]> => executeGaqlRows(token, customerId, query, options);

export const executeGaqlDetailed = async (
    token: string,
    customerId: string,
    query: string,
    options: ExecuteGaqlOptions = {}
): Promise<ExecuteGaqlResult> => executeGaqlWithMetadata(token, customerId, query, options);

export const getResourceMetadata = async (token: string, query: string): Promise<any[]> => {
    const rows: any[] = [];
    let pageToken: string | undefined;
    do {
        const response = await requestGoogleAdsJson<any>({
            token,
            path: 'googleAdsFields:search',
            body: pageToken ? { query, pageToken } : { query },
            retryMode: 'read'
        });
        if (Array.isArray(response.data?.results)) rows.push(...response.data.results);
        pageToken = response.data?.nextPageToken;
    } while (pageToken);
    return rows;
};
