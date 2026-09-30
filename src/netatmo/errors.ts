import { HttpError } from "../http";

export type NetatmoErrorKind =
    /** Connection problems or no response. */
    | "network"
    /** Refresh token or client credentials rejected; a new token has to be generated. */
    | "auth"
    /** The access token is invalid or expired; renewing it helps. */
    | "token"
    /** Too many requests (Netatmo allows 500 per hour per user). */
    | "rateLimit"
    /** The token lacks the scope read_station. */
    | "scope"
    /** The app on dev.netatmo.com was deactivated. */
    | "appDeactivated"
    /** Any other error reported by the API. */
    | "api";

export class NetatmoError extends Error {
    constructor(
        message: string,
        readonly kind: NetatmoErrorKind,
        readonly status?: number,
        readonly code?: number | string,
        /** How long Netatmo asks to wait before the next request (Retry-After). */
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "NetatmoError";
    }
}

interface ErrorBody {
    error?: unknown;
    error_description?: unknown;
}

/**
 * Error codes of the Netatmo API ({"error": {"code": …, "message": …}}), see "Error messages"
 * in the API glossary on dev.netatmo.com.
 */
const GRANT_INVALID = -1;
const ACCESS_TOKEN_INVALID = 2;
const ACCESS_TOKEN_EXPIRED = 3;
/** HTTP 406 */
const APPLICATION_DEACTIVATED = 5;
/** "Operation forbidden", e.g. the token lacks the scope. */
const SCOPE_MISSING = 13;
const MAXIMUM_USAGE_REACHED = 26;
const RATE_LIMIT_EXCEEDED = 28;
const TEMPORARILY_RESTRICTED = 29;
const INVALID_REFRESH_TOKEN = 30;

/** Retry-After in seconds or as HTTP date. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds))
        return seconds >= 0 ? seconds * 1000 : undefined;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Maps an error response of the token endpoint (OAuth2) to a {@link NetatmoError}. */
export function tokenError(status: number, body: unknown, retryAfter?: string): NetatmoError {
    const parsed = (body && typeof body === "object" ? body : {}) as ErrorBody;
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const description = typeof parsed.error_description === "string" ? `: ${parsed.error_description}` : "";
    const message = `token request failed (HTTP ${status}${error ? ` ${error}` : ""}${description})`;
    if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client" || status === 401)
        return new NetatmoError(message, "auth", status, error);
    if (status === 429)
        return new NetatmoError(message, "rateLimit", status, error, parseRetryAfter(retryAfter));
    return new NetatmoError(message, status >= 500 || status === 0 ? "network" : "api", status, error);
}

/** Maps an error response of the data API to a {@link NetatmoError}. */
export function apiError(status: number, body: unknown, endpoint: string, retryAfter?: string): NetatmoError {
    const error = body && typeof body === "object" ? (body as ErrorBody).error : undefined;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    const text = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : typeof error === "string" ? error : "";
    const numericCode = typeof code === "number" ? code : undefined;
    const message = `${endpoint}: HTTP ${status}${numericCode !== undefined ? ` code ${numericCode}` : ""}${text ? ` ${text}` : ""}`;

    if (numericCode === ACCESS_TOKEN_INVALID || numericCode === ACCESS_TOKEN_EXPIRED || status === 401)
        return new NetatmoError(message, "token", status, numericCode);
    if (status === 429 || numericCode === MAXIMUM_USAGE_REACHED || numericCode === RATE_LIMIT_EXCEEDED || numericCode === TEMPORARILY_RESTRICTED)
        return new NetatmoError(message, "rateLimit", status, numericCode, parseRetryAfter(retryAfter));
    if (numericCode === GRANT_INVALID || numericCode === INVALID_REFRESH_TOKEN)
        return new NetatmoError(message, "auth", status, numericCode);
    if (status === 406 && numericCode === APPLICATION_DEACTIVATED)
        return new NetatmoError(message, "appDeactivated", status, numericCode);
    if (numericCode === SCOPE_MISSING)
        return new NetatmoError(message, "scope", status, numericCode);
    return new NetatmoError(message, status >= 500 ? "network" : "api", status, numericCode);
}

export function fromHttpError(error: unknown): unknown {
    return error instanceof HttpError ? new NetatmoError(error.message, "network", undefined, error.code) : error;
}
