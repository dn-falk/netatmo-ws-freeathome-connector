import { Bridge, BridgeSettings, DeviceProvider } from "./bridge/bridge";
import {
    ConfigResult,
    Settings,
    TOKEN_GROUP,
    TOKEN_STATE_ITEM,
    TokenState,
    WEBHOOK_GROUP,
    WEBHOOK_REGISTERED_ITEM,
    groupItems,
    parseConfiguration,
    parseTokenState,
    restartKey,
    withRegisteredWebhook,
    withTokenState,
} from "./config";
import { Logger, errorMessage } from "./log";
import { WEBHOOK_PORT } from "./netatmo/webhook";
import { AddonStatus, fromBridgeStatus } from "./status";

const MAX_REWRITES = 3;

function withItemsCopy(configuration: unknown): Record<string, unknown> {
    return configuration && typeof configuration === "object"
        ? JSON.parse(JSON.stringify(configuration)) as Record<string, unknown>
        : {};
}

export interface DeviceRegistry extends DeviceProvider {
    setAllAvailable(available: boolean): Promise<void>;
    republishAll(): Promise<void>;
}

export interface AppDependencies {
    registry: DeviceRegistry;
    publishStatus(status: AddonStatus): void;
    /** Writes the addon configuration (used to store the refresh token). */
    saveConfiguration(configuration: Record<string, unknown>): Promise<unknown>;
    createBridge?(settings: BridgeSettings, deps: BridgeCallbacks): Bridge;
}

export interface BridgeCallbacks {
    devices: DeviceProvider;
    onRefreshToken(token: string): void;
    onWebhookRegistered(url: string | undefined): void;
}

/** Local port of the webhook endpoint; NETATMO_WEBHOOK_PORT overrides it for development and tests. */
export function webhookPort(env = process.env): number {
    const port = Number(env.NETATMO_WEBHOOK_PORT);
    return env.NETATMO_WEBHOOK_PORT && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : WEBHOOK_PORT;
}

export function toBridgeSettings(settings: Settings): BridgeSettings {
    return {
        credentials: { clientId: settings.clientId, clientSecret: settings.clientSecret },
        refreshToken: settings.refreshToken,
        plan: {
            weatherStation: settings.temperatureSource !== "off" || settings.rainSource !== "off"
                || settings.windSource !== "off" || settings.brightnessSource !== "off",
            indoorSensors: settings.indoorSensors,
            outdoorHumidity: settings.outdoorHumidity,
            excluded: settings.excluded,
            nameLanguage: settings.nameLanguage,
        },
        weather: {
            temperatureSource: settings.temperatureSource,
            rainSource: settings.rainSource,
            windSource: settings.windSource,
            windValue: settings.windValue,
            rainHoldMs: settings.rainHoldMs,
            rainMinStations: settings.rainMinStations,
        },
        brightnessSource: settings.brightnessSource,
        publicRadiusKm: settings.publicRadiusKm,
        location: settings.location,
        maxPollIntervalMs: settings.maxPollIntervalMs,
        webhook: settings.webhookUrl ? { url: settings.webhookUrl, port: webhookPort() } : undefined,
        registeredWebhookUrl: settings.registeredWebhookUrl,
    };
}

/**
 * Reacts to configuration changes: (re)starts the bridge with the new settings, stores the
 * refresh tokens issued by Netatmo in the configuration and keeps the status up to date.
 */
export class App {
    private bridge: Bridge | undefined;
    private appliedKey: string | undefined;
    private chain: Promise<void> = Promise.resolve();
    private status: AddonStatus = { state: "starting" };
    /** The configuration as last received (the stored token is written into a copy of it). */
    private configuration: unknown;
    /** Token state that should be in the configuration. */
    private tokenState: TokenState | undefined;
    private saving: Promise<void> = Promise.resolve();
    /** Times the current token state was written again because the configuration lacked it. */
    private rewrites = 0;
    /** Webhook URL registered by the addon, once a bridge reported it (newer than the configuration). */
    private registeredWebhook: { url: string | undefined } | undefined;
    private readonly statusListeners = new Set<(status: AddonStatus) => void>();
    private readonly log = new Logger("app");

    constructor(private readonly deps: AppDependencies) {}

    getStatus(): AddonStatus {
        return this.status;
    }

    /**
     * Resolves with the status as soon as `settled` accepts it, at the latest after `timeoutMs`
     * with the status at that time.
     */
    waitForStatus(settled: (status: AddonStatus) => boolean, timeoutMs: number): Promise<AddonStatus> {
        if (settled(this.status))
            return Promise.resolve(this.status);
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.statusListeners.delete(listener);
                resolve(this.status);
            };
            const listener = (status: AddonStatus) => {
                if (settled(status))
                    done();
            };
            const timer = setTimeout(done, timeoutMs);
            this.statusListeners.add(listener);
        });
    }

    /** Applies a configuration; calls are processed one after another. */
    applyConfiguration(configuration: unknown): Promise<void> {
        this.chain = this.chain
            .then(() => this.apply(configuration))
            .catch((error) => this.log.error(`could not apply configuration: ${errorMessage(error)}`, error));
        return this.chain;
    }

    resync(): void {
        if (this.bridge) {
            this.log.info("reading the Netatmo stations again");
            this.bridge.resync();
        }
    }

    /** The connection to the System Access Point was (re)established: send all states again. */
    async republish(): Promise<void> {
        await this.deps.registry.republishAll();
    }

    async shutdown(): Promise<void> {
        await this.chain;
        await this.stopBridge();
        await this.saving;
    }

    private async apply(configuration: unknown): Promise<void> {
        this.configuration = configuration;
        const result: ConfigResult = parseConfiguration(configuration);
        Logger.debugEnabled = result.ok && result.settings.debug;
        const key = restartKey(result);
        if (key === this.appliedKey) {
            this.checkStoredToken(configuration);
            return;
        }
        this.appliedKey = key;

        await this.stopBridge();
        if (!result.ok) {
            this.log.warn(`configuration incomplete: ${result.problems.map((problem) => problem.en).join(", ")}`);
            this.tokenState = undefined;
            await this.deps.registry.setAllAvailable(false);
            this.setStatus({ state: "configurationNeeded", problems: result.problems });
            return;
        }

        const origin = result.settings.tokenOrigin;
        // The configuration may contain an older token than the one the addon received last
        // (settings saved in the app with the state loaded before a renewal): the newest one wins.
        if (this.tokenState?.origin !== origin)
            this.tokenState = { origin, refreshToken: result.settings.refreshToken };
        const settings = toBridgeSettings({
            ...result.settings,
            refreshToken: this.tokenState.refreshToken,
            registeredWebhookUrl: this.registeredWebhook ? this.registeredWebhook.url : result.settings.registeredWebhookUrl,
        });
        const bridgeDeps: BridgeCallbacks = {
            devices: this.deps.registry,
            // Also from a bridge that is being stopped: its token is the newest one then.
            onRefreshToken: (token: string) => {
                if (this.tokenState?.origin === origin)
                    this.storeToken({ origin, refreshToken: token });
            },
            onWebhookRegistered: (url) => this.storeWebhook(url),
        };
        const bridge = this.deps.createBridge
            ? this.deps.createBridge(settings, bridgeDeps)
            : new Bridge(settings, bridgeDeps);
        bridge.on("status", (status) => {
            if (bridge === this.bridge)
                this.setStatus(fromBridgeStatus(status));
        });
        this.bridge = bridge;
        this.setStatus({ state: "connecting" });
        bridge.start();
    }

    /**
     * Writes the token back if the configuration does not contain the current one, e.g. because
     * the settings were saved in the app with the token state loaded before the last renewal.
     * The same for the webhook URL registered by the addon.
     */
    private checkStoredToken(configuration: unknown): void {
        if (!this.tokenState)
            return;
        const stored = parseTokenState(groupItems(configuration, TOKEN_GROUP)[TOKEN_STATE_ITEM]);
        const storedWebhook = groupItems(configuration, WEBHOOK_GROUP)[WEBHOOK_REGISTERED_ITEM];
        const webhookStored = !this.registeredWebhook || (storedWebhook || undefined) === this.registeredWebhook.url;
        if (stored?.origin === this.tokenState.origin && stored.refreshToken === this.tokenState.refreshToken && webhookStored)
            return;
        // Never more than a few times, so that the addon and the System Access Point cannot
        // send the configuration back and forth endlessly.
        if (this.rewrites >= MAX_REWRITES)
            return;
        this.rewrites++;
        this.log.info("the configuration does not contain the current refresh token or webhook, storing them again");
        this.storeToken(this.tokenState, false);
    }

    /** The configuration with the values the addon stores itself. */
    private withStoredValues(configuration: unknown): Record<string, unknown> {
        let result = this.tokenState ? withTokenState(configuration, this.tokenState) : withItemsCopy(configuration);
        if (this.registeredWebhook)
            result = withRegisteredWebhook(result, this.registeredWebhook.url);
        return result;
    }

    private storeToken(state: TokenState, isNew = true): void {
        if (isNew)
            this.rewrites = 0;
        this.tokenState = state;
        this.saving = this.saving
            .then(async () => {
                const configuration = this.withStoredValues(this.configuration);
                this.configuration = configuration;
                await this.deps.saveConfiguration(configuration);
                this.log.info("refresh token stored in the addon configuration");
            })
            .catch((error) => this.log.error(`could not store the refresh token: ${errorMessage(error)}`
                + " - if the addon restarts now, a new token may have to be generated"));
    }

    /** Remembers the webhook URL registered by the addon, so it can be replaced or removed later. */
    private storeWebhook(url: string | undefined): void {
        this.registeredWebhook = { url };
        this.saving = this.saving
            .then(async () => {
                const configuration = this.withStoredValues(this.configuration);
                this.configuration = configuration;
                await this.deps.saveConfiguration(configuration);
            })
            .catch((error) => this.log.error(`could not store the registered webhook: ${errorMessage(error)}`));
    }

    private async stopBridge(): Promise<void> {
        const bridge = this.bridge;
        this.bridge = undefined;
        if (bridge)
            await bridge.stop();
    }

    private setStatus(status: AddonStatus): void {
        this.status = status;
        this.deps.publishStatus(status);
        for (const listener of [...this.statusListeners])
            listener(status);
    }
}
