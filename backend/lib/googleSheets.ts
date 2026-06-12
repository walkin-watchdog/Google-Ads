import { getGoogleAccessToken } from './googleOAuth';

export interface SheetValuesResult {
    range?: string;
    majorDimension?: string;
    values?: string[][];
}

export interface GoogleSheetFile {
    id: string;
    name: string;
    modifiedTime?: string;
    createdTime?: string;
    webViewLink?: string;
}

export async function fetchSheetRows(input: {
    spreadsheetId: string;
    range: string;
    refreshToken?: string;
}): Promise<string[][]> {
    if (!input.spreadsheetId.trim()) throw new Error('Missing Google Sheets spreadsheet ID.');
    if (!input.range.trim()) throw new Error('Missing Google Sheets range.');

    const token = await getGoogleAccessToken({ refreshToken: input.refreshToken });
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`);
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => null) as SheetValuesResult & { error?: any };
    if (!res.ok) {
        throw new Error(`Failed to fetch Google Sheet rows: ${JSON.stringify(data?.error || data)}`);
    }
    return Array.isArray(data.values) ? data.values.map(row => row.map(cell => String(cell ?? ''))) : [];
}

function escapeDriveQueryString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findLatestSpreadsheetByName(input: {
    spreadsheetName: string;
    refreshToken: string;
}): Promise<GoogleSheetFile | null> {
    const spreadsheetName = input.spreadsheetName.trim();
    if (!spreadsheetName) throw new Error('Missing Google Sheet name.');
    if (!input.refreshToken?.trim()) throw new Error('Missing GOOGLE_SHEETS_REFRESH_TOKEN.');

    const token = await getGoogleAccessToken({ refreshToken: input.refreshToken });
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `name = '${escapeDriveQueryString(spreadsheetName)}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`);
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', '1');
    url.searchParams.set('fields', 'files(id,name,modifiedTime,createdTime,webViewLink)');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => null) as { files?: GoogleSheetFile[]; error?: any };
    if (!res.ok) {
        throw new Error(`Failed to find latest Google Sheet named "${spreadsheetName}": ${JSON.stringify(data?.error || data)}`);
    }
    return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

export async function fetchLatestSheetRowsByName(input: {
    spreadsheetName: string;
    range?: string;
    refreshToken: string;
}): Promise<{ file: GoogleSheetFile; rows: string[][] }> {
    const file = await findLatestSpreadsheetByName({
        spreadsheetName: input.spreadsheetName,
        refreshToken: input.refreshToken
    });
    if (!file) throw new Error(`No Google Sheet file found with the name "${input.spreadsheetName}".`);
    const rows = await fetchSheetRows({
        spreadsheetId: file.id,
        range: input.range || 'A:Z',
        refreshToken: input.refreshToken
    });
    return { file, rows };
}
