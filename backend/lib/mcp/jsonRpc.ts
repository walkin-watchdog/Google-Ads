export const JSON_RPC_VERSION = '2.0';

export class McpJsonRpcError extends Error {
    code: number;
    statusCode: number;
    data?: any;

    constructor(code: number, message: string, statusCode = 400, data?: any) {
        super(message);
        this.name = 'McpJsonRpcError';
        this.code = code;
        this.statusCode = statusCode;
        this.data = data;
    }
}

export function jsonRpcSuccess(id: any, result: any): Record<string, any> {
    return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, result };
}

export function jsonRpcError(id: any, err: any): Record<string, any> {
    const error = err instanceof McpJsonRpcError
        ? { code: err.code, message: err.message, data: err.data }
        : { code: -32603, message: err?.message || 'Internal error' };
    if (error.data === undefined) delete error.data;
    return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error };
}

export function requireJsonRpcRequest(body: any): { id: any; method: string; params: Record<string, any> } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new McpJsonRpcError(-32600, 'Invalid JSON-RPC request object.');
    }
    if (body.jsonrpc !== JSON_RPC_VERSION) {
        throw new McpJsonRpcError(-32600, 'JSON-RPC version must be 2.0.');
    }
    if (typeof body.method !== 'string' || !body.method.trim()) {
        throw new McpJsonRpcError(-32600, 'JSON-RPC method is required.');
    }
    return {
        id: body.id,
        method: body.method,
        params: body.params && typeof body.params === 'object' ? body.params : {}
    };
}

export function invalidParams(message: string, data?: any): McpJsonRpcError {
    return new McpJsonRpcError(-32602, message, 400, data);
}

export function methodNotFound(method: string): McpJsonRpcError {
    return new McpJsonRpcError(-32601, `Method not found: ${method}`, 404);
}

export function notInitialized(): McpJsonRpcError {
    return new McpJsonRpcError(-32002, 'MCP session is not initialized. Send initialize and notifications/initialized first.', 400);
}

export function unauthorized(message: string): McpJsonRpcError {
    return new McpJsonRpcError(-32001, message, 401);
}

export function forbidden(message: string, data?: any): McpJsonRpcError {
    return new McpJsonRpcError(-32003, message, 403, data);
}

export function rateLimited(message: string, data?: any): McpJsonRpcError {
    return new McpJsonRpcError(-32029, message, 429, data);
}
