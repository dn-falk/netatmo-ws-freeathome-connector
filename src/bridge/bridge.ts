import { EventEmitter } from "node:events";

import { BrightnessSource } from "../config";
import { SensorValues } from "../fah/datapoints";
import { FahDevice, VirtualDeviceType } from "../fah/device";
import { Logger, errorMessage } from "../log";
import { ClientCredentials, NETATMO_BASE_URL, NetatmoApi, NetatmoClient } from "../netatmo/client";
import { NetatmoError } from "../netatmo/errors";
import { boundingBox, parsePublicStations, PublicStation } from "../netatmo/publicData";
import { Location, ModuleData, ModuleType, StationData, allModules, firstModule, isFresh, parseStations } from "../netatmo/stations";
import { TokenManager } from "../netatmo/tokenManager";
import { PublicDataKind } from "../netatmo/types";
import { LiveValues, WebhookEvent, parseWebhookEvent } from "../netatmo/webhook";
import { BrightnessService, BrightnessState, BrightSkyProvider, OpenMeteoProvider, RadiationProvider } from "../weather/brightness";
import { describeStationSources } from "../status";
import { LiveData } from "./live";
import { PlanSettings, PlannedDevice, planDevices } from "./plan";
import { PollSchedule } from "./schedule";
import { WebhookService, WebhookSettings, WebhookStatus } from "./webhook";
import { PublicSnapshot, SourceInfo, StationWeather, WeatherSettings, publicKindsNeeded } from "./weather";

export interface BridgeSettings {
    credentials: ClientCredentials;
    refreshToken: string;
    plan: PlanSettings;
    weather: WeatherSettings;
    brightnessSource: BrightnessSource;
    publicRadiusKm: number;
    /** Overrides the location of the stations (weather map, brightness). */
    location?: Location;
    maxPollIntervalMs: number;
    /** Receive the values by webhook (undefined: only query them). */
    webhook?: WebhookSettings;
    /** Webhook URL the addon registered earlier (stored in the configuration). */
    registeredWebhookUrl?: string;
}

export interface DeviceProvider {
    getOrCreate(nativeId: string, name: string, type: VirtualDeviceType): Promise<FahDevice>;
    /** All free@home devices created so far (also those of earlier configurations). */
    createdDevices(): Promise<FahDevice[]>;
}

export interface BridgeDependencies {
    devices: DeviceProvider;
    /** Called with every new refresh token issued by Netatmo, to be stored. */
    onRefreshToken(refreshToken: string): void;
    api?: NetatmoApi;
    createRadiationProvider?: (source: BrightnessSource) => RadiationProvider | undefined;
    now?: () => number;
    log?: Logger;
    /** Interval for brightness, rain hold time and reachability (default 1 min). */
    tickIntervalMs?: number;
    /** Waiting times after failed requests (tests use short ones). */
    retryDelaysMs?: number[];
    /** Shortest wait between two queries of the station data (default 1 min). */
    minPollIntervalMs?: number;
    /** Called when the webhook URL registered by the addon changes (to be stored). */
    onWebhookRegistered?(url: string | undefined): void;
    /** A module counts as covered by webhooks while they brought its values within this time (default 15 min). */
    webhookCoverageMs?: number;
    /** Query of the station data while webhooks cover all modules (default 60 min). */
    webhookPollIntervalMs?: number;
    /** Shortest wait between two queries requested by webhooks (default 10 min). */
    webhookTriggeredPollSpacingMs?: number;
    /** The plan of the next request is checked at least this often (default 1 min). */
    recheckIntervalMs?: number;
    /** Age at which the weather map is read again (default 9 min). */
    publicRefreshMs?: number;
}

export type BridgeState = "connecting" | "online" | "offline";

/** Where the values of the weather station of a Netatmo station come from. */
export interface StationSources {
    station: string;
    temperature: SourceInfo;
    rain: SourceInfo;
    wind: SourceInfo;
    /** undefined if the brightness is off */
    brightness?: BrightnessState | { source: "none" };
}

export interface BridgeStatus {
    state: BridgeState;
    stations: number;
    devices: number;
    error?: Error;
    sources: StationSources[];
    /** free@home devices the settings provide (`devices`: the ones set up so far) */
    plannedDevices: number;
    /** false until the first update after the start (devices, weather map, values) has finished */
    complete: boolean;
    /** undefined if no webhook is configured */
    webhook?: WebhookStatus;
}

interface ManagedDevice {
    plan: PlannedDevice;
    device: FahDevice;
}

interface CachedPublicData {
    stations: PublicStation[];
    fetchedAt: number;
}

const PUBLIC_REFRESH_MS = 9 * 60_000;
/** Wait after a failed request to the weather map while webhooks make the station queries rare. */
const PUBLIC_RETRY_MS = 5 * 60_000;
/** 1.5 upload intervals: one late or missing webhook does not end the coverage. */
const WEBHOOK_COVERAGE_MS = 15 * 60_000;
/** Names, batteries and new modules are only in the station data. */
const WEBHOOK_POLL_INTERVAL_MS = 60 * 60_000;
const WEBHOOK_TRIGGERED_POLL_SPACING_MS = 10 * 60_000;
const RECHECK_INTERVAL_MS = 60_000;
const WEBHOOK_RECHECK_AFTER_DELETION_MS = 60_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const AUTH_RETRY_DELAY_MS = 30 * 60_000;
const RATE_LIMIT_DELAY_MS = 15 * 60_000;
const STOP_WAIT_MS = 1_500;
const LOW_BATTERY_PERCENT = 20;
/** The System Access Point needs many seconds for every new virtual device. */
const PARALLEL_DEVICE_CREATIONS = 4;

export declare interface Bridge {
    on(event: "status", listener: (status: BridgeStatus) => void): this;
}

function defaultRadiationProvider(source: BrightnessSource): RadiationProvider | undefined {
    switch (source) {
        case "openmeteo":
            return new OpenMeteoProvider(process.env.OPEN_METEO_URL || undefined);
        case "brightsky":
            return new BrightSkyProvider(process.env.BRIGHT_SKY_URL || undefined);
        default:
            return undefined;
    }
}

/** Modules whose values the weather station uses (first outdoor, wind and rain module). */
const WEATHER_MODULES: readonly ModuleType[] = ["NAModule1", "NAModule2", "NAModule3"];

/**
 * Connects the Netatmo stations with virtual free@home devices: fetches the station data
 * shortly after every upload of the station, fills in missing values from the public weather
 * map and a weather service, and writes the values to the free@home devices.
 *
 * With a webhook, Netatmo sends the values itself within seconds. As long as the webhooks bring
 * the values of all modules in use, the station data is only queried once an hour (names,
 * batteries, new modules); as soon as a module is no longer covered, the regular queries take
 * over again. Whether a device is reachable does not depend on the way the values arrive: it is
 * shown as not reachable when its values are older than 60 minutes or Netatmo reports the module
 * as not reachable in the station data.
 */
export class Bridge extends EventEmitter {
    private readonly api: NetatmoApi;
    private readonly tokens: TokenManager;
    private readonly log: Logger;
    private readonly now: () => number;
    private readonly managed = new Map<string, ManagedDevice>();
    private readonly weather = new Map<string, StationWeather>();
    private readonly brightness = new Map<string, BrightnessService>();
    private readonly publicData = new Map<string, Partial<Record<PublicDataKind, CachedPublicData>>>();
    private readonly lowBattery = new Set<string>();
    private readonly schedule: PollSchedule;
    private readonly live = new LiveData();
    private readonly webhook: WebhookService;
    /** Station data of the last query (without the values of the webhooks, see {@link currentStations}). */
    private stations: StationData[] = [];
    /** Modules whose values the free@home devices use. */
    private usedModules = new Set<string>();
    private plannedDevices = 0;
    /** Netatmo stations with a free@home weather station in the settings. */
    private weatherStationIds = new Set<string>();
    private state: BridgeState = "connecting";
    private error: Error | undefined;
    private sources: StationSources[] = [];
    private complete = false;
    private lastSourcesText = "";
    private lastEmitted = "";
    private running = false;
    private failures = 0;
    private lastPollAt: number | undefined;
    private lastPollFailed = false;
    /** Next query according to the regular schedule (or the retry after an error). */
    private nextScheduledPollAt = 0;
    /** "Reload stations": query right away. */
    private forcePoll = false;
    /** A webhook asked for the station data (module not reachable, new module, changed home). */
    private pollRequested = false;
    private lastRequestedPollAt = Number.NEGATIVE_INFINITY;
    /** No requests to the weather map outside the station queries before this time (after errors). */
    private publicBlockedUntil = 0;
    private loopPromise: Promise<void> | undefined;
    private tickTimer: NodeJS.Timeout | undefined;
    private wake: (() => void) | undefined;
    private publishing: Promise<void> = Promise.resolve();

    constructor(private readonly settings: BridgeSettings, private readonly deps: BridgeDependencies) {
        super();
        this.log = deps.log ?? new Logger("bridge");
        this.now = deps.now ?? Date.now;
        this.api = deps.api ?? new NetatmoClient(process.env.NETATMO_API_URL || NETATMO_BASE_URL, this.log.child("netatmo"));
        this.tokens = new TokenManager(this.api, {
            credentials: settings.credentials,
            refreshToken: settings.refreshToken,
            onRefreshToken: (token) => deps.onRefreshToken(token),
            now: this.now,
        }, this.log.child("token"));
        this.schedule = new PollSchedule(deps.minPollIntervalMs ?? 60_000, settings.maxPollIntervalMs);
        this.webhook = new WebhookService({
            settings: settings.webhook,
            registeredUrl: settings.registeredWebhookUrl,
            clientSecret: settings.credentials.clientSecret,
            api: this.api,
            withAccessToken: (request) => this.tokens.withAccessToken(request),
            onEvent: (body) => this.onWebhook(body),
            onRegistered: (url) => deps.onWebhookRegistered?.(url),
            now: this.now,
            log: this.log.child("webhook"),
        });
    }

    get status(): BridgeStatus {
        return {
            state: this.state,
            stations: this.stations.length,
            devices: this.managed.size,
            error: this.error,
            sources: this.sources,
            plannedDevices: this.plannedDevices,
            complete: this.complete,
            webhook: this.webhookStatus(this.now()),
        };
    }

    /** Port of the local webhook endpoint (undefined if it does not listen). */
    get webhookPort(): number | undefined {
        return this.webhook.port;
    }

    /** The refresh token currently in use (the latest one issued by Netatmo). */
    get refreshToken(): string {
        return this.tokens.currentRefreshToken;
    }

    start(): void {
        if (this.running)
            return;
        this.running = true;
        this.loopPromise = this.loop();
        this.tickTimer = setInterval(() => this.tick(), this.deps.tickIntervalMs ?? 60_000);
        if (this.webhook.enabled) {
            void this.webhook.start().then(() => {
                if (this.state !== "connecting")
                    this.emitStatus();
            });
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.tickTimer)
            clearInterval(this.tickTimer);
        this.wake?.();
        // The port has to be free for the next bridge (configuration changed).
        const webhookStopped = this.webhook.stop();
        // Do not wait for a running request (up to its timeout); the loop ends after it anyway.
        await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
        await webhookStopped;
        this.managed.clear();
    }

    /** Reads the station data again now (e.g. after modules were added in the Netatmo app). */
    resync(): void {
        this.forcePoll = true;
        this.wake?.();
    }

    /** Sends all values to free@home again (e.g. after the System Access Point restarted). */
    republish(): void {
        for (const { device } of this.managed.values())
            device.republish();
    }

    /** One request after the other: station data, webhook registration, weather map. */
    private async loop(): Promise<void> {
        while (this.running) {
            const now = this.now();
            const pollAt = this.pollDueAt(now);
            if (pollAt <= now) {
                await this.runPoll();
                continue;
            }
            const webhookAt = this.webhook.dueAt();
            if (webhookAt <= now) {
                await this.webhook.reconcile();
                this.emitStatus();
                continue;
            }
            const publicAt = this.publicDueAt(now);
            if (publicAt <= now) {
                await this.refreshPublicData();
                continue;
            }
            // Webhooks can stop at any time: check the plan again regularly.
            const recheck = this.deps.recheckIntervalMs ?? RECHECK_INTERVAL_MS;
            await this.sleep(Math.max(1, Math.min(pollAt, webhookAt, publicAt, now + recheck) - now));
        }
    }

    private async runPoll(): Promise<void> {
        const requested = this.pollRequested && !this.forcePoll && this.lastPollAt !== undefined;
        this.forcePoll = false;
        this.pollRequested = false;
        try {
            const delay = await this.poll();
            this.failures = 0;
            this.lastPollFailed = false;
            this.nextScheduledPollAt = this.now() + delay;
        } catch (error) {
            if (!this.running)
                return;
            this.lastPollFailed = true;
            this.nextScheduledPollAt = this.now() + this.handleError(error);
        }
        this.lastPollAt = this.now();
        if (requested)
            this.lastRequestedPollAt = this.lastPollAt;
        if (!this.lastPollFailed && this.webhookActive(this.lastPollAt)) {
            this.log.debug(`webhooks bring the values of all modules, next query of the station data in`
                + ` ${minutes(this.pollDueAt(this.lastPollAt) - this.lastPollAt)} min`);
        }
        this.emitStatus();
    }

    /** When the station data is to be queried next. */
    private pollDueAt(now: number): number {
        if (this.forcePoll || this.lastPollAt === undefined)
            return now;
        if (this.lastPollFailed)
            return this.nextScheduledPollAt;
        let due = this.webhookActive(now)
            ? this.lastPollAt + (this.deps.webhookPollIntervalMs ?? WEBHOOK_POLL_INTERVAL_MS)
            : this.nextScheduledPollAt;
        if (this.pollRequested) {
            const spacing = this.deps.webhookTriggeredPollSpacingMs ?? WEBHOOK_TRIGGERED_POLL_SPACING_MS;
            due = Math.min(due, Math.max(this.lastPollAt + (this.deps.minPollIntervalMs ?? 60_000), this.lastRequestedPollAt + spacing));
        }
        return due;
    }

    /** A webhook asks for the station data (rate limited, see {@link pollDueAt}). */
    private requestPoll(): void {
        this.pollRequested = true;
        this.wake?.();
    }

    /** Fetches the station data and updates everything; returns the wait until the next poll. */
    private async poll(): Promise<number> {
        const queriedAt = this.now();
        const body = await this.tokens.withAccessToken((token) => this.api.getStationsData(token));
        if (!this.running)
            return 0;
        const stations = parseStations(body);
        const firstTime = this.state !== "online";
        const plan = planDevices(stations, this.settings.plan);
        this.stations = stations;
        this.live.prune(stations, queriedAt);
        this.plannedDevices = plan.length;
        this.weatherStationIds = new Set(plan.filter((device) => device.type === "WeatherStation").map((device) => device.stationId));
        this.usedModules = usedModules(stations, plan);
        this.state = "online";
        this.error = undefined;
        this.webhook.activate();
        if (firstTime) {
            this.log.info(`connected to Netatmo: ${stations.length} station(s)`
                + stations.map((station) => ` '${station.name}' (${allModules(station).map((module) => module.name).join(", ")})`).join(","));
            // Right away: creating the devices and reading the weather map can take a while.
            this.emitStatus();
        }
        this.checkBatteries(stations);
        // Weather map and weather service first: new devices get all their values right away.
        await this.updatePublicData(this.currentStations());
        if (this.running)
            await this.updateBrightness();
        if (this.running)
            await this.syncDevices(plan);
        this.publishAll();
        this.complete = true;
        return this.nextPollDelay(stations);
    }

    /** Wait until shortly after the next expected upload of the stations. */
    private nextPollDelay(stations: StationData[]): number {
        const now = this.now();
        const times = stations.map((station) => station.main.time).filter((time): time is number => time !== undefined);
        const latest = times.length > 0 ? Math.max(...times) : undefined;
        const delay = this.schedule.next(latest, now);
        if (latest !== undefined) {
            this.log.debug(`latest measurement ${minutes(now - latest)} min old (Netatmo delay ${minutes(this.schedule.deliveryDelayMs)} min),`
                + ` next query in ${minutes(delay)} min`);
        }
        return delay;
    }

    private handleError(error: unknown): number {
        const err = error instanceof Error ? error : new Error(String(error));
        this.failures++;
        const kind = err instanceof NetatmoError ? err.kind : undefined;
        const permanent = kind === "auth" || kind === "scope" || kind === "appDeactivated";
        if (permanent || kind === "rateLimit" || this.failures >= 2) {
            if (this.state !== "offline" || this.error?.message !== err.message)
                this.log.warn(`Netatmo not available: ${errorMessage(err)}`);
            this.state = "offline";
            this.error = err;
        } else {
            this.log.info(`request failed, retrying: ${errorMessage(err)}`);
        }
        if (permanent)
            return AUTH_RETRY_DELAY_MS;
        if (kind === "rateLimit")
            return Math.max(RATE_LIMIT_DELAY_MS, (err as NetatmoError).retryAfterMs ?? 0);
        const delays = this.deps.retryDelaysMs ?? RETRY_DELAYS_MS;
        return delays[Math.min(this.failures - 1, delays.length - 1)];
    }

    private checkBatteries(stations: StationData[]): void {
        for (const module of stations.flatMap(allModules)) {
            if (module.batteryPercent === undefined)
                continue;
            if (module.batteryPercent <= LOW_BATTERY_PERCENT && !this.lowBattery.has(module.id)) {
                this.lowBattery.add(module.id);
                this.log.warn(`battery of the Netatmo module '${module.name}' is low (${module.batteryPercent} %)`);
            } else if (module.batteryPercent > LOW_BATTERY_PERCENT + 5) {
                this.lowBattery.delete(module.id);
            }
        }
    }

    private async syncDevices(plan: PlannedDevice[]): Promise<void> {
        const wanted = new Set(plan.map((device) => device.nativeId));
        const missing: PlannedDevice[] = [];
        for (const planned of plan) {
            const known = this.managed.get(planned.nativeId);
            if (known)
                known.plan = planned;
            else
                missing.push(planned);
        }
        await this.createDevices(missing);
        if (!this.running)
            return;
        for (const [nativeId, { device }] of this.managed) {
            if (wanted.has(nativeId))
                continue;
            this.log.info(`'${device.name}' is no longer provided (module removed or excluded), marking it unreachable`);
            this.managed.delete(nativeId);
            await device.setAvailable(false);
        }
        // Devices of earlier configurations (e.g. separate sensors after switching to combined ones).
        const managedDevices = new Set([...this.managed.values()].map((entry) => entry.device));
        for (const device of await this.deps.devices.createdDevices()) {
            if (!managedDevices.has(device) && device.isAvailable) {
                this.log.info(`free@home device '${device.name}' is not used with the current settings, marking it unreachable`);
                await device.setAvailable(false);
            }
        }
    }

    /**
     * Creates several devices at the same time (the System Access Point needs many seconds for
     * each one on the first start); every device shows its values as soon as it is there.
     */
    private async createDevices(missing: PlannedDevice[]): Promise<void> {
        const queue = [...missing];
        const work = async () => {
            for (let planned = queue.shift(); planned && this.running; planned = queue.shift()) {
                try {
                    const device = await this.deps.devices.getOrCreate(planned.nativeId, planned.name, planned.type);
                    if (!this.running)
                        return;
                    this.managed.set(planned.nativeId, { plan: planned, device });
                    this.publishAll();
                    this.emitStatus();
                } catch (error) {
                    this.log.error(`could not create free@home device '${planned.name}': ${errorMessage(error)}`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL_DEVICE_CREATIONS, queue.length) }, work));
    }

    private stationLocation(station: StationData): Location | undefined {
        return this.settings.location ?? station.location;
    }

    private async updatePublicData(stations: StationData[]): Promise<void> {
        const ownIds = new Set(stations.map((station) => station.id));
        for (const station of stations) {
            if (!this.hasWeatherStation(station))
                continue;
            const center = this.stationLocation(station);
            const kinds = publicKindsNeeded(station, this.settings.weather, this.now());
            if (!center || kinds.length === 0)
                continue;
            const cache = this.publicData.get(station.id) ?? {};
            this.publicData.set(station.id, cache);
            for (const kind of kinds) {
                if (!this.running)
                    return;
                const cached = cache[kind];
                if (cached && this.now() - cached.fetchedAt < this.publicRefreshMs)
                    continue;
                try {
                    const box = boundingBox(center, this.settings.publicRadiusKm);
                    const raw = await this.tokens.withAccessToken((token) => this.api.getPublicData(token, box, kind));
                    const nearby = parsePublicStations(raw, center, this.settings.publicRadiusKm, ownIds);
                    cache[kind] = { stations: nearby, fetchedAt: this.now() };
                    this.log.debug(`weather map (${kind}): ${nearby.length} station(s) within ${this.settings.publicRadiusKm} km`
                        + (nearby.length ? `, nearest ${nearby.slice(0, 5).map((entry) => `${entry.distanceKm.toFixed(1)} km`).join(", ")}` : ""));
                } catch (error) {
                    this.log.warn(`could not read the public weather map (${kind}): ${errorMessage(error)}`);
                    const kindOfError = error instanceof NetatmoError ? error.kind : undefined;
                    this.publicBlockedUntil = this.now() + (kindOfError === "rateLimit" ? RATE_LIMIT_DELAY_MS : PUBLIC_RETRY_MS);
                    if (kindOfError === "rateLimit" || kindOfError === "auth" || kindOfError === "appDeactivated")
                        return;
                }
            }
        }
    }

    private get publicRefreshMs(): number {
        return this.deps.publicRefreshMs ?? PUBLIC_REFRESH_MS;
    }

    /**
     * When the weather map is to be read without a query of the station data: only while
     * webhooks make those queries rare (otherwise it is read with every query).
     */
    private publicDueAt(now: number): number {
        if (this.lastPollFailed || !this.webhookActive(now))
            return Number.POSITIVE_INFINITY;
        let due = Number.POSITIVE_INFINITY;
        for (const station of this.currentStations()) {
            if (!this.hasWeatherStation(station) || !this.stationLocation(station))
                continue;
            const cache = this.publicData.get(station.id) ?? {};
            for (const kind of publicKindsNeeded(station, this.settings.weather, now))
                due = Math.min(due, (cache[kind]?.fetchedAt ?? Number.NEGATIVE_INFINITY) + this.publicRefreshMs);
        }
        return due === Number.POSITIVE_INFINITY ? due : Math.max(due, this.publicBlockedUntil);
    }

    private async refreshPublicData(): Promise<void> {
        await this.updatePublicData(this.currentStations());
        this.publishAll();
        this.emitStatus();
    }

    private hasWeatherStation(station: StationData): boolean {
        return this.weatherStationIds.has(station.id);
    }

    /** The station data of the last query with the newer values of the webhooks. */
    private currentStations(): StationData[] {
        return this.live.merge(this.stations);
    }

    /**
     * True while webhooks bring the values of every module in use that currently has values:
     * then the station data is only queried rarely.
     */
    private webhookActive(now: number): boolean {
        if (!this.webhook.enabled || this.live.lastEventAt === undefined)
            return false;
        const coverage = this.deps.webhookCoverageMs ?? WEBHOOK_COVERAGE_MS;
        let used = 0;
        for (const module of this.currentStations().flatMap(allModules)) {
            if (!this.usedModules.has(module.id) || !isFresh(module, now))
                continue;
            if (!this.live.covered(module.id, now, coverage))
                return false;
            used++;
        }
        return used > 0;
    }

    private webhookStatus(now: number): WebhookStatus | undefined {
        const status = this.webhook.status();
        return status ? { ...status, lastEventAt: this.live.lastEventAt, active: this.webhookActive(now) } : undefined;
    }

    private onWebhook(body: unknown): void {
        if (!this.running)
            return;
        // One event per request according to the documentation; a list is taken as well.
        if (Array.isArray(body)) {
            body.forEach((entry) => this.onWebhook(entry));
            return;
        }
        const event = parseWebhookEvent(body);
        if (!event) {
            this.log.debug("webhook without push_type ignored");
            return;
        }
        switch (event.pushType) {
            case "device_event":
                this.onDeviceEvent(event);
                break;
            case "topology_changed":
                this.log.info("Netatmo reports a change of the home (topology_changed), reading the stations again");
                this.requestPoll();
                break;
            case "webhook_activation":
                this.log.info("Netatmo confirms the webhook (webhook_activation)");
                break;
            case "webhook_deletion":
                this.log.warn("Netatmo reports that the webhook was removed (webhook_deletion), checking the registration");
                this.webhook.scheduleCheck(WEBHOOK_RECHECK_AFTER_DELETION_MS);
                this.wake?.();
                break;
            default:
                this.log.debug(`webhook ${event.pushType} ignored`);
        }
        this.emitStatus();
    }

    private onDeviceEvent(event: WebhookEvent): void {
        if (this.stations.length === 0)
            return; // before the first query: the modules are not known yet
        const now = this.now();
        const first = this.live.lastEventAt === undefined;
        const result = this.live.apply(event, this.stations, now);
        if (result.updated.length > 0) {
            const names = result.updated.map((module) => module.name).join(", ");
            if (first)
                this.log.info(`first webhook with values received from Netatmo (${names})`);
            const values = new Map(event.modules.map((entry) => [entry.id, entry.values]));
            this.log.debug(`webhook: ${result.updated.map((module) => `${module.name} ${describeValues(values.get(module.id.toLowerCase()) ?? {})}`).join("; ")}`);
            this.publishAll();
        }
        if (result.outdated > 0)
            this.log.debug(`webhook: values of ${result.outdated} module(s) older than the known ones, ignored`);
        // Whether a module is reachable is taken from the station data, which is read for it:
        // Netatmo does not guarantee the order of the webhooks.
        const lost = result.unreachable.filter((module) => this.managedModule(module.id) && isFresh(this.currentModule(module.id), now));
        if (lost.length > 0) {
            this.log.info(`Netatmo reports ${lost.map((module) => `'${module.name}'`).join(", ")} as not reachable, reading the station data`);
            this.requestPoll();
        }
        if (result.unknown.length > 0) {
            this.log.info(`webhook with values of unknown module(s) ${result.unknown.join(", ")}, reading the stations again`);
            this.requestPoll();
        }
    }

    private managedModule(moduleId: string): boolean {
        return this.usedModules.has(moduleId);
    }

    private currentModule(moduleId: string): ModuleData | undefined {
        return this.currentStations().flatMap(allModules).find((module) => module.id === moduleId);
    }

    private brightnessService(station: StationData): BrightnessService | undefined {
        if (this.settings.brightnessSource === "off")
            return undefined;
        let service = this.brightness.get(station.id);
        if (!service) {
            const create = this.deps.createRadiationProvider ?? defaultRadiationProvider;
            service = new BrightnessService(create(this.settings.brightnessSource), this.log.child("brightness"));
            this.brightness.set(station.id, service);
        }
        return service;
    }

    private async updateBrightness(): Promise<void> {
        const now = this.now();
        await Promise.all(this.stations.map((station) => {
            const location = this.stationLocation(station);
            return location && this.hasWeatherStation(station) ? this.brightnessService(station)?.update(now, location) : undefined;
        }));
    }

    /** Brightness, rain hold time and reachability change with time: publish every minute. */
    private tick(): void {
        this.publishing = this.publishing
            .then(async () => {
                if (!this.running || this.stations.length === 0)
                    return;
                await this.updateBrightness();
                if (this.running)
                    this.publishAll();
                this.emitStatus();
            })
            .catch((error) => this.log.error(`update failed: ${errorMessage(error)}`, error));
    }

    private publicSnapshot(station: StationData): PublicSnapshot {
        const cache = this.publicData.get(station.id) ?? {};
        const snapshot: PublicSnapshot = {};
        for (const kind of ["temperature", "rain", "wind"] as const) {
            const entry = cache[kind];
            if (entry)
                snapshot[kind] = entry.stations;
        }
        return snapshot;
    }

    /** Computes all values from the latest data and writes them to the free@home devices. */
    private publishAll(): void {
        // A stopped bridge (e.g. after a configuration change) no longer writes to the devices.
        if (!this.running)
            return;
        const now = this.now();
        const sources: StationSources[] = [];
        const stations = this.currentStations();
        for (const { plan, device } of this.managed.values()) {
            const station = stations.find((candidate) => candidate.id === plan.stationId);
            if (!station)
                continue;
            if (plan.type === "WeatherStation") {
                const values = this.weatherValues(station, now, sources);
                this.show(device, values, Object.values(values).some((value) => value !== undefined));
            } else {
                const module = allModules(station).find((candidate) => candidate.id === plan.moduleId);
                const fresh = isFresh(module, now);
                this.show(device, fresh ? moduleValues(module, plan) : {}, fresh);
            }
        }
        this.sources = sources;
        const text = JSON.stringify(sources.map(({ brightness, ...rest }) => ({ ...rest, brightness: brightness?.source })));
        if (text !== this.lastSourcesText) {
            this.lastSourcesText = text;
            for (const entry of sources)
                this.log.info(`weather station '${entry.station}': ${describeStationSources(entry).en}`);
        }
    }

    private weatherValues(station: StationData, now: number, sources: StationSources[]): SensorValues {
        let weather = this.weather.get(station.id);
        if (!weather) {
            weather = new StationWeather();
            this.weather.set(station.id, weather);
        }
        const result = weather.compute(station, this.publicSnapshot(station), this.settings.weather, now);
        const values: SensorValues = { ...result.values };
        const entry: StationSources = { station: station.name, ...result.sources };
        const location = this.stationLocation(station);
        const service = this.brightnessService(station);
        if (service && location) {
            const brightness = service.current(now, location);
            values.brightness = brightness.lux;
            entry.brightness = brightness;
        } else if (service) {
            entry.brightness = { source: "none" };
        }
        sources.push(entry);
        return values;
    }

    private show(device: FahDevice, values: SensorValues, available: boolean): void {
        if (available) {
            // Values first: a device that becomes reachable again sends all of them.
            device.update(values);
            if (!device.isAvailable)
                void device.setAvailable(true);
        } else if (device.isAvailable) {
            void device.setAvailable(false);
        }
    }

    private emitStatus(): void {
        if (!this.running)
            return;
        const status = this.status;
        // Without the brightness values, which change every minute, and the time of the last webhook.
        const webhook = status.webhook
            ? [status.webhook.listening, status.webhook.registration, status.webhook.registrationError, status.webhook.active,
                status.webhook.lastEventAt !== undefined, status.webhook.rejected > 0]
            : undefined;
        const key = JSON.stringify([status.state, status.stations, status.devices, status.plannedDevices, status.error?.message, this.lastSourcesText, status.complete, webhook]);
        if (key === this.lastEmitted)
            return;
        this.lastEmitted = key;
        this.emit("status", status);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            if (!this.running) {
                resolve();
                return;
            }
            const timer = setTimeout(() => {
                this.wake = undefined;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
        });
    }
}

function minutes(ms: number): string {
    return (ms / 60_000).toFixed(1);
}

/** Modules whose values the planned free@home devices show. */
function usedModules(stations: StationData[], plan: PlannedDevice[]): Set<string> {
    const ids = new Set<string>();
    for (const device of plan) {
        if (device.moduleId !== undefined) {
            ids.add(device.moduleId);
            continue;
        }
        const station = stations.find((candidate) => candidate.id === device.stationId);
        for (const type of WEATHER_MODULES) {
            const module = station && firstModule(station, type);
            if (module)
                ids.add(module.id);
        }
    }
    return ids;
}

function describeValues(values: LiveValues): string {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name} ${value}`)
        .join(", ") || "(no values)";
}

/** Values of a module that a free@home sensor shows. */
function moduleValues(module: ModuleData, plan: PlannedDevice): SensorValues {
    const values: SensorValues = {};
    for (const quantity of plan.quantities) {
        const value = module[quantity];
        if (value !== undefined)
            values[quantity] = value;
    }
    return values;
}
