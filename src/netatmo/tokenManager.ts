import { Logger } from "../log";
import { ClientCredentials, NetatmoApi } from "./client";
import { NetatmoError } from "./errors";

/** The access token is renewed this long before it expires. */
const RENEW_BEFORE_EXPIRY_MS = 10 * 60_000;
/** Used if the token response has no (plausible) lifetime; Netatmo tokens last 3 hours. */
const DEFAULT_LIFETIME_S = 10_800;

export interface TokenManagerOptions {
    credentials: ClientCredentials;
    refreshToken: string;
    /** Called with every new refresh token; the old one is no longer valid then. */
    onRefreshToken(refreshToken: string): void;
    now?: () => number;
}

/**
 * Holds the OAuth2 tokens of the Netatmo account. The access token is renewed with the refresh
 * token shortly before it expires. Netatmo issues a new refresh token on every renewal and
 * invalidates the previous one, so every new one is handed to {@link TokenManagerOptions.onRefreshToken}
 * to be stored.
 */
export class TokenManager {
    private refresh: string;
    private access: string | undefined;
    private expiresAt = 0;
    private pending: Promise<string> | undefined;
    private readonly now: () => number;

    constructor(private readonly api: NetatmoApi, private readonly options: TokenManagerOptions, private readonly log = new Logger("token")) {
        this.refresh = options.refreshToken;
        this.now = options.now ?? Date.now;
    }

    get currentRefreshToken(): string {
        return this.refresh;
    }

    /** Returns a valid access token; renews it if necessary (only one renewal at a time). */
    async accessToken(): Promise<string> {
        if (this.access && this.now() < this.expiresAt - RENEW_BEFORE_EXPIRY_MS)
            return this.access;
        this.pending ??= this.renew().finally(() => this.pending = undefined);
        return this.pending;
    }

    /** The API rejected the access token: the next call to {@link accessToken} renews it. */
    invalidate(rejected: string): void {
        if (this.access === rejected)
            this.access = undefined;
    }

    /**
     * Runs a request with a valid access token. If the API rejects the token although it
     * should still be valid, it is renewed and the request is repeated once.
     */
    async withAccessToken<T>(request: (accessToken: string) => Promise<T>): Promise<T> {
        const token = await this.accessToken();
        try {
            return await request(token);
        } catch (error) {
            if (!(error instanceof NetatmoError) || error.kind !== "token")
                throw error;
            this.log.info("access token rejected, renewing it");
            this.invalidate(token);
            return request(await this.accessToken());
        }
    }

    private async renew(): Promise<string> {
        const used = this.refresh;
        const response = await this.api.refreshToken(this.options.credentials, used);
        const lifetime = typeof response.expires_in === "number" && response.expires_in > 60 ? response.expires_in : DEFAULT_LIFETIME_S;
        this.access = response.access_token;
        this.expiresAt = this.now() + lifetime * 1000;
        if (response.refresh_token && response.refresh_token !== used) {
            this.refresh = response.refresh_token;
            this.log.info("Netatmo issued a new refresh token, storing it");
            try {
                this.options.onRefreshToken(response.refresh_token);
            } catch (error) {
                this.log.error(`could not store the refresh token: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else {
            this.log.debug("access token renewed");
        }
        return this.access as string;
    }
}
