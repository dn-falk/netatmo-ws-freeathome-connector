import { HttpResponse, httpRequest, parseJson } from "../http";
import { Logger } from "../log";
import { NetatmoError, apiError, fromHttpError, tokenError } from "./errors";
import { BoundingBox, PublicDataKind, RawPublicStation, StationsDataBody, TokenResponse } from "./types";

export const NETATMO_BASE_URL = "https://api.netatmo.com";

export interface ClientCredentials {
    clientId: string;
    clientSecret: string;
}

/** Subset of the Netatmo API used by the addon (allows fakes in tests). */
export interface NetatmoApi {
    refreshToken(credentials: ClientCredentials, refreshToken: string): Promise<TokenResponse>;
    getStationsData(accessToken: string): Promise<StationsDataBody>;
    getPublicData(accessToken: string, box: BoundingBox, kind: PublicDataKind): Promise<RawPublicStation[]>;
    /** URLs of the webhooks registered for the user of the token (Webhooks API). */
    getWebhooks(accessToken: string): Promise<string[]>;
    addWebhook(accessToken: string, url: string): Promise<void>;
    /** Replaces all webhooks of the user. */
    replaceWebhooks(accessToken: string, urls: string[]): Promise<void>;
    /** Removes all webhooks of the user. */
    deleteWebhooks(accessToken: string): Promise<void>;
}

const WEBHOOKS_PATH = "/webhooks/v1/";

const TIMEOUT_MS = 20_000;

interface WebhookEntry {
    url?: unknown;
}

/** HTTPS client for the Netatmo cloud (OAuth2 token endpoint and Weather API). */
export class NetatmoClient implements NetatmoApi {
    private readonly baseUrl: string;

    constructor(baseUrl = NETATMO_BASE_URL, private readonly log = new Logger("netatmo")) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    async refreshToken(credentials: ClientCredentials, refreshToken: string): Promise<TokenResponse> {
        const response = await this.send("POST", "/oauth2/token", undefined, {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
        });
        const body = parseJson(response.text);
        if (response.status < 200 || response.status >= 300)
            throw tokenError(response.status, body, response.retryAfter);
        const token = body as TokenResponse | undefined;
        if (!token || typeof token.access_token !== "string" || !token.access_token)
            throw new NetatmoError("token response without access token", "api", response.status);
        return token;
    }

    async getStationsData(accessToken: string): Promise<StationsDataBody> {
        const body = await this.api<StationsDataBody>("/api/getstationsdata", accessToken, {});
        return body && typeof body === "object" ? body : {};
    }

    async getPublicData(accessToken: string, box: BoundingBox, kind: PublicDataKind): Promise<RawPublicStation[]> {
        const body = await this.api<RawPublicStation[]>("/api/getpublicdata", accessToken, {
            lat_ne: box.latNE.toFixed(5),
            lon_ne: box.lonNE.toFixed(5),
            lat_sw: box.latSW.toFixed(5),
            lon_sw: box.lonSW.toFixed(5),
            required_data: kind,
            filter: "true",
        });
        return Array.isArray(body) ? body : [];
    }

    async getWebhooks(accessToken: string): Promise<string[]> {
        const body = await this.webhooks("GET", accessToken);
        return (Array.isArray(body) ? body : [])
            .map((entry) => entry && typeof entry === "object" ? (entry as WebhookEntry).url : undefined)
            .filter((url): url is string => typeof url === "string" && url !== "");
    }

    async addWebhook(accessToken: string, url: string): Promise<void> {
        await this.webhooks("POST", accessToken, { url });
    }

    async replaceWebhooks(accessToken: string, urls: string[]): Promise<void> {
        await this.webhooks("PUT", accessToken, urls.map((url) => ({ url })));
    }

    async deleteWebhooks(accessToken: string): Promise<void> {
        await this.webhooks("DELETE", accessToken);
    }

    /** Request to the Webhooks API (JSON in both directions); returns the "body" of the answer. */
    private async webhooks(method: "GET" | "POST" | "PUT" | "DELETE", accessToken: string, json?: unknown): Promise<unknown> {
        const response = await this.send(method, WEBHOOKS_PATH, undefined, undefined, { Authorization: `Bearer ${accessToken}` }, json);
        const body = parseJson(response.text);
        if (response.status < 200 || response.status >= 300)
            throw apiError(response.status, body, "webhooks", response.retryAfter);
        return body && typeof body === "object" ? (body as { body?: unknown }).body : undefined;
    }

    private async api<T>(path: string, accessToken: string, query: Record<string, string>): Promise<T | undefined> {
        const response = await this.send("GET", path, query, undefined, { Authorization: `Bearer ${accessToken}` });
        const body = parseJson(response.text);
        if (response.status < 200 || response.status >= 300)
            throw apiError(response.status, body, path, response.retryAfter);
        if (!body || typeof body !== "object")
            throw new NetatmoError(`${path}: invalid response`, "api", response.status);
        return (body as { body?: T }).body;
    }

    private async send(method: "GET" | "POST" | "PUT" | "DELETE", path: string, query?: Record<string, string>,
        form?: Record<string, string>, headers?: Record<string, string>, json?: unknown): Promise<HttpResponse> {
        const url = new URL(this.baseUrl + path);
        for (const [key, value] of Object.entries(query ?? {}))
            url.searchParams.set(key, value);
        const started = Date.now();
        try {
            const response = await httpRequest({ method, url, form, json, headers, timeoutMs: TIMEOUT_MS });
            this.log.debug(`${method} ${path} -> ${response.status} (${Date.now() - started} ms, ${response.text.length} bytes)`);
            return response;
        } catch (error) {
            throw fromHttpError(error);
        }
    }
}
