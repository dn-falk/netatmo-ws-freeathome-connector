import { EventEmitter } from "node:events";

import { BrightnessSource } from "../config";
import { SensorValues } from "../fah/datapoints";
import { FahDevice, VirtualDeviceType } from "../fah/device";
import { Logger, errorMessage } from "../log";
import { ClientCredentials, NETATMO_BASE_URL, NetatmoApi, NetatmoClient } from "../netatmo/client";
import { NetatmoError } from "../netatmo/errors";
import { boundingBox, parsePublicStations, PublicStation } from "../netatmo/publicData";
import { Location, ModuleData, StationData, allModules, isFresh, parseStations } from "../netatmo/stations";
import { TokenManager } from "../netatmo/tokenManager";
import { PublicDataKind } from "../netatmo/types";
import { BrightnessService, BrightnessState, BrightSkyProvider, OpenMeteoProvider, RadiationProvider } from "../weather/brightness";
import { describeStationSources } from "../status";
import { PlanSettings, PlannedDevice, planDevices } from "./plan";
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
}

interface ManagedDevice {
    plan: PlannedDevice;
    device: FahDevice;
}

interface CachedPublicData {
    stations: PublicStation[];
    fetchedAt: number;
}

/** The cloud gets new values from the station every 10 minutes. */
const UPLOAD_INTERVAL_MS = 10 * 60_000;
/** Wait after the expected upload before asking (the cloud needs a moment). */
const UPLOAD_DELAY_MS = 30_000;
const PUBLIC_REFRESH_MS = 9 * 60_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const AUTH_RETRY_DELAY_MS = 30 * 60_000;
const RATE_LIMIT_DELAY_MS = 15 * 60_000;
const STOP_WAIT_MS = 1_500;
const LOW_BATTERY_PERCENT = 20;

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

/**
 * Connects the Netatmo stations with virtual free@home devices: fetches the station data
 * shortly after every upload of the station, fills in missing values from the public weather
 * map and a weather service, and writes the values to the free@home devices.
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
    private stations: StationData[] = [];
    private state: BridgeState = "connecting";
    private error: Error | undefined;
    private sources: StationSources[] = [];
    private lastSourcesText = "";
    private lastEmitted = "";
    private running = false;
    private failures = 0;
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
    }

    get status(): BridgeStatus {
        return {
            state: this.state,
            stations: this.stations.length,
            devices: this.managed.size,
            error: this.error,
            sources: this.sources,
        };
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
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.tickTimer)
            clearInterval(this.tickTimer);
        this.wake?.();
        // Do not wait for a running request (up to its timeout); the loop ends after it anyway.
        await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
        this.managed.clear();
    }

    /** Reads the station data again now (e.g. after modules were added in the Netatmo app). */
    resync(): void {
        this.wake?.();
    }

    /** Sends all values to free@home again (e.g. after the System Access Point restarted). */
    republish(): void {
        for (const { device } of this.managed.values())
            device.republish();
    }

    private async loop(): Promise<void> {
        while (this.running) {
            let delay: number;
            try {
                delay = await this.poll();
                this.failures = 0;
            } catch (error) {
                if (!this.running)
                    break;
                delay = this.handleError(error);
            }
            this.emitStatus();
            await this.sleep(delay);
        }
    }

    /** Fetches the station data and updates everything; returns the wait until the next poll. */
    private async poll(): Promise<number> {
        const body = await this.tokens.withAccessToken((token) => this.api.getStationsData(token));
        if (!this.running)
            return 0;
        const stations = parseStations(body);
        const firstTime = this.state !== "online";
        this.stations = stations;
        this.state = "online";
        this.error = undefined;
        if (firstTime) {
            this.log.info(`connected to Netatmo: ${stations.length} station(s)`
                + stations.map((station) => ` '${station.name}' (${allModules(station).map((module) => module.name).join(", ")})`).join(","));
        }
        this.checkBatteries(stations);
        await this.syncDevices(stations);
        if (this.running)
            await this.updatePublicData(stations);
        if (this.running)
            await this.updateBrightness();
        this.publishAll();
        return this.nextPollDelay(stations);
    }

    /** Wait until shortly after the next expected upload of the stations. */
    private nextPollDelay(stations: StationData[]): number {
        const now = this.now();
        const minimum = this.deps.minPollIntervalMs ?? 60_000;
        const maximum = Math.max(minimum, this.settings.maxPollIntervalMs);
        const times = stations.map((station) => station.main.time).filter((time): time is number => time !== undefined);
        if (times.length === 0)
            return maximum;
        const latest = Math.max(...times);
        if (now - latest > 2 * UPLOAD_INTERVAL_MS)
            return maximum; // station offline, no upload expected soon
        const expected = latest + UPLOAD_INTERVAL_MS + UPLOAD_DELAY_MS;
        return Math.min(maximum, Math.max(minimum, expected - now));
    }

    private handleError(error: unknown): number {
        const err = error instanceof Error ? error : new Error(String(error));
        this.failures++;
        const kind = err instanceof NetatmoError ? err.kind : undefined;
        const permanent = kind === "auth" || kind === "scope";
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
            return RATE_LIMIT_DELAY_MS;
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

    private async syncDevices(stations: StationData[]): Promise<void> {
        const plan = planDevices(stations, this.settings.plan);
        const wanted = new Set(plan.map((device) => device.nativeId));
        for (const planned of plan) {
            const known = this.managed.get(planned.nativeId);
            if (known) {
                known.plan = planned;
                continue;
            }
            try {
                const device = await this.deps.devices.getOrCreate(planned.nativeId, planned.name, planned.type);
                if (!this.running)
                    return;
                this.managed.set(planned.nativeId, { plan: planned, device });
            } catch (error) {
                this.log.error(`could not create free@home device '${planned.name}': ${errorMessage(error)}`);
            }
        }
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
                if (cached && this.now() - cached.fetchedAt < PUBLIC_REFRESH_MS)
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
                    if (error instanceof NetatmoError && (error.kind === "rateLimit" || error.kind === "auth"))
                        return;
                }
            }
        }
    }

    private hasWeatherStation(station: StationData): boolean {
        return [...this.managed.values()].some((entry) => entry.plan.type === "WeatherStation" && entry.plan.stationId === station.id);
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
        for (const { plan, device } of this.managed.values()) {
            const station = this.stations.find((candidate) => candidate.id === plan.stationId);
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
        // Without the brightness values, which change every minute.
        const key = JSON.stringify([status.state, status.stations, status.devices, status.error?.message, this.lastSourcesText]);
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
