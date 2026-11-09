import { Logger, errorMessage } from "../log";
import { NetatmoApi } from "../netatmo/client";
import { NetatmoError } from "../netatmo/errors";
import { WebhookServer } from "../webhookServer";

export interface WebhookSettings {
    /** Public URL under which Netatmo reaches the addon (forwarded to `port` of the System Access Point). */
    url: string;
    /** Local port the addon listens on. */
    port: number;
}

export type WebhookRegistration = "pending" | "registered" | "failed";

export interface WebhookStatus {
    url: string;
    port: number;
    listening: boolean;
    listenError?: string;
    registration: WebhookRegistration;
    registrationError?: string;
    /** HTTP status of the failed registration (403: the app may not use the Webhooks API). */
    registrationStatus?: number;
    /** Requests rejected because of a missing or wrong signature. */
    rejected: number;
    /** Last webhook with values of the own stations. */
    lastEventAt?: number;
    /** Webhooks bring the values of all modules in use: the station data is queried rarely. */
    active: boolean;
}

export interface WebhookServiceOptions {
    /** undefined: no webhook (only an earlier registration of the addon is removed). */
    settings?: WebhookSettings;
    /** URL the addon registered earlier (stored in the configuration). */
    registeredUrl?: string;
    clientSecret: string;
    api: NetatmoApi;
    withAccessToken<T>(request: (accessToken: string) => Promise<T>): Promise<T>;
    onEvent(body: unknown): void;
    /** The URL registered by the addon changed (undefined: none); to be stored. */
    onRegistered(url: string | undefined): void;
    now: () => number;
    log: Logger;
}

/** The registration is checked again this often (Netatmo may drop it, e.g. on a new authorisation). */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const RATE_LIMIT_DELAY_MS = 15 * 60_000;

function sameUrl(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined)
        return a === b;
    return normaliseUrl(a) === normaliseUrl(b);
}

function normaliseUrl(url: string): string {
    try {
        return new URL(url.trim()).href;
    } catch {
        return url.trim();
    }
}

/**
 * Webhook of the Netatmo app: the local endpoint (see {@link WebhookServer}) and the
 * registration of its public URL for the user of the token (Webhooks API, POST/PUT/DELETE
 * /webhooks/v1). Webhooks registered by others for the same app and user are left alone; only
 * the URL the addon registered itself is replaced or removed.
 */
export class WebhookService {
    private server: WebhookServer | undefined;
    private listening = false;
    private listenError: string | undefined;
    private registration: WebhookRegistration = "pending";
    private registrationError: string | undefined;
    private registrationStatus: number | undefined;
    /** URL registered by the addon, as far as known. */
    private registered: string | undefined;
    private checkAt = Number.POSITIVE_INFINITY;
    private failures = 0;

    constructor(private readonly options: WebhookServiceOptions) {
        this.registered = options.registeredUrl;
    }

    get enabled(): boolean {
        return this.options.settings !== undefined;
    }

    /** Port the endpoint listens on (undefined if it does not). */
    port: number | undefined;

    /** Opens the local endpoint; errors are kept for the status. */
    async start(): Promise<void> {
        const settings = this.options.settings;
        if (!settings || this.server)
            return;
        const server = new WebhookServer({
            port: settings.port,
            clientSecret: this.options.clientSecret,
            onEvent: (body) => this.options.onEvent(body),
            log: this.options.log,
        });
        this.server = server;
        try {
            this.port = await server.start();
            this.listening = true;
            this.listenError = undefined;
            this.options.log.info(`webhook endpoint listening on port ${this.port}, public URL ${settings.url}`);
        } catch (error) {
            this.listening = false;
            this.listenError = errorMessage(error);
            this.options.log.warn(`could not open port ${settings.port} for the webhook: ${this.listenError}`
                + " - the addon keeps querying Netatmo regularly");
        }
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.listening = false;
        this.checkAt = Number.POSITIVE_INFINITY;
        await server?.stop();
    }

    /** The token works (first query done): check the registration now if there is anything to do. */
    activate(): void {
        if (this.checkAt === Number.POSITIVE_INFINITY && this.registration === "pending"
            && (this.options.settings !== undefined || this.registered !== undefined))
            this.checkAt = this.options.now();
    }

    /** Checks the registration again after `delayMs` (e.g. Netatmo reported its removal). */
    scheduleCheck(delayMs: number): void {
        if (this.options.settings !== undefined)
            this.checkAt = Math.min(this.checkAt, this.options.now() + delayMs);
    }

    /** When {@link reconcile} is due. */
    dueAt(): number {
        return this.checkAt;
    }

    /**
     * Makes sure Netatmo knows the configured URL (and no longer the one the addon registered
     * before). Never throws; failures are retried later.
     */
    async reconcile(): Promise<void> {
        const desired = this.options.settings?.url;
        const previous = this.registered;
        const log = this.options.log;
        this.checkAt = Number.POSITIVE_INFINITY;
        try {
            const current = await this.options.withAccessToken((token) => this.options.api.getWebhooks(token));
            const has = (urls: string[], url: string) => urls.some((candidate) => sameUrl(candidate, url));
            let next = current.filter((url) => !(previous !== undefined && sameUrl(url, previous) && !sameUrl(previous, desired)));
            if (desired !== undefined && !has(next, desired))
                next = [...next, desired];
            const unchanged = next.length === current.length && next.every((url) => has(current, url));
            if (!unchanged) {
                if (next.length === 0) {
                    await this.options.withAccessToken((token) => this.options.api.deleteWebhooks(token));
                } else if (desired !== undefined && next.length === current.length + 1 && current.every((url) => has(next, url))) {
                    await this.options.withAccessToken((token) => this.options.api.addWebhook(token, desired));
                } else {
                    await this.options.withAccessToken((token) => this.options.api.replaceWebhooks(token, next));
                }
            }
            if (desired !== undefined) {
                log.info(unchanged ? `webhook ${desired} is registered with Netatmo` : `webhook ${desired} registered with Netatmo`);
            } else if (!unchanged) {
                log.info(`webhook ${previous} removed from Netatmo`);
            }
            this.registered = desired;
            if (!sameUrl(desired, previous))
                this.options.onRegistered(desired);
            this.failures = 0;
            this.registration = "registered";
            this.registrationError = undefined;
            this.registrationStatus = undefined;
            if (desired !== undefined)
                this.checkAt = this.options.now() + CHECK_INTERVAL_MS;
        } catch (error) {
            const status = error instanceof NetatmoError ? error.status : undefined;
            if (desired === undefined) {
                // Only an earlier registration was to be removed; without access to the
                // Webhooks API (HTTP 403) there is none.
                log.warn(`could not remove the webhook ${previous} from Netatmo: ${errorMessage(error)}`);
                if (status === 403) {
                    this.registered = undefined;
                    this.options.onRegistered(undefined);
                }
                return;
            }
            this.failures++;
            this.registration = "failed";
            this.registrationError = errorMessage(error);
            this.registrationStatus = status;
            const retry = error instanceof NetatmoError && error.kind === "rateLimit"
                ? Math.max(RATE_LIMIT_DELAY_MS, error.retryAfterMs ?? 0)
                : RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)];
            this.checkAt = this.options.now() + retry;
            log.warn(`could not register the webhook with Netatmo: ${this.registrationError}`
                + ` - the addon keeps querying Netatmo regularly, next attempt in ${Math.round(retry / 60_000)} min`);
        }
    }

    /** Status of the endpoint and the registration; undefined if no webhook is configured. */
    status(): Omit<WebhookStatus, "lastEventAt" | "active"> | undefined {
        const settings = this.options.settings;
        if (!settings)
            return undefined;
        return {
            url: settings.url,
            port: settings.port,
            listening: this.listening,
            listenError: this.listenError,
            registration: this.registration,
            registrationError: this.registrationError,
            registrationStatus: this.registrationStatus,
            rejected: this.server?.rejected ?? 0,
        };
    }
}
