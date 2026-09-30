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
    /** Any other error reported by the API. */
    | "api";

export class NetatmoError extends Error {
    constructor(message: string, readonly kind: NetatmoErrorKind, readonly status?: number, readonly code?: number | string) {
        super(message);
        this.name = "NetatmoError";
    }
}

interface ErrorBody {
    error?: unknown;
    error_description?: unknown;
}

/** Error codes of the Netatmo API ({"error": {"code": …, "message": …}}). */
const ACCESS_TOKEN_INVALID = 2;
const ACCESS_TOKEN_EXPIRED = 3;
const SCOPE_MISSING = 13;
const USER_USAGE_REACHED = 26;

/** Maps an error response of the token endpoint (OAuth2) to a {@link NetatmoError}. */
export function tokenError(status: number, body: unknown): NetatmoError {
    const parsed = (body && typeof body === "object" ? body : {}) as ErrorBody;
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const description = typeof parsed.error_description === "string" ? `: ${parsed.error_description}` : "";
    const message = `token request failed (HTTP ${status}${error ? ` ${error}` : ""}${description})`;
    if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client" || status === 401)
        return new NetatmoError(message, "auth", status, error);
    if (status === 429)
        return new NetatmoError(message, "rateLimit", status, error);
    return new NetatmoError(message, status >= 500 || status === 0 ? "network" : "api", status, error);
}

/** Maps an error response of the data API to a {@link NetatmoError}. */
export function apiError(status: number, body: unknown, endpoint: string): NetatmoError {
    const error = body && typeof body === "object" ? (body as ErrorBody).error : undefined;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    const text = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : typeof error === "string" ? error : "";
    const numericCode = typeof code === "number" ? code : undefined;
    const message = `${endpoint}: HTTP ${status}${numericCode !== undefined ? ` code ${numericCode}` : ""}${text ? ` ${text}` : ""}`;

    if (numericCode === ACCESS_TOKEN_INVALID || numericCode === ACCESS_TOKEN_EXPIRED || status === 401)
        return new NetatmoError(message, "token", status, numericCode);
    if (numericCode === USER_USAGE_REACHED || status === 429)
        return new NetatmoError(message, "rateLimit", status, numericCode);
    if (numericCode === SCOPE_MISSING)
        return new NetatmoError(message, "scope", status, numericCode);
    return new NetatmoError(message, status >= 500 ? "network" : "api", status, numericCode);
}

export function fromHttpError(error: unknown): unknown {
    return error instanceof HttpError ? new NetatmoError(error.message, "network", undefined, error.code) : error;
}
