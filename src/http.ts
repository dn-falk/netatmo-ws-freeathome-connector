import * as http from "node:http";
import * as https from "node:https";

export type HttpErrorKind =
    /** Connection problems (refused, reset, DNS, TLS). */
    | "network"
    /** No response within the timeout. */
    | "timeout";

export class HttpError extends Error {
    constructor(message: string, readonly kind: HttpErrorKind, readonly code?: string) {
        super(message);
        this.name = "HttpError";
    }
}

export interface HttpResponse {
    status: number;
    text: string;
}

export interface HttpRequest {
    method: "GET" | "POST";
    url: URL;
    headers?: Record<string, string>;
    /** Form fields, sent as application/x-www-form-urlencoded. */
    form?: Record<string, string>;
    timeoutMs: number;
}

/** Upper limit for a response body; public weather data of a city is a few hundred kB. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Minimal HTTP(S) client. The addon only makes a few requests per minute, so every request
 * opens its own connection; nothing stays open between the queries.
 */
export function httpRequest(request: HttpRequest): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
        const payload = request.form ? Buffer.from(new URLSearchParams(request.form).toString()) : undefined;
        const headers: http.OutgoingHttpHeaders = {
            Accept: "application/json",
            "User-Agent": "netatmo-ws-freeathome-connector",
            ...request.headers,
        };
        if (payload) {
            headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
            headers["Content-Length"] = payload.length;
        }
        const transport = request.url.protocol === "http:" ? http : https;
        const description = `${request.method} ${request.url.origin}${request.url.pathname}`;

        const req = transport.request(request.url, { method: request.method, headers, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    req.destroy(new HttpError(`${description}: response too large`, "network"));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("error", (error) => reject(new HttpError(`${description}: ${error.message}`, "network")));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.setTimeout(request.timeoutMs, () => {
            req.destroy(new HttpError(`${description}: no response within ${request.timeoutMs} ms`, "timeout"));
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
            reject(error instanceof HttpError ? error : new HttpError(`${description}: ${error.message}`, "network", error.code));
        });
        req.end(payload);
    });
}

/** Parses a JSON response body; undefined if it is not JSON. */
export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}
