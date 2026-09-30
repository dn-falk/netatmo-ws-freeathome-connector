import { httpRequest, parseJson } from "../http";
import { Logger, errorMessage } from "../log";
import { Location } from "../netatmo/stations";
import { LUX_PER_WATT, clearSkyIrradiance, solarElevation, twilightIlluminance } from "./sun";

export type RadiationSourceName = "openmeteo" | "brightsky";

/** Mean global horizontal irradiance over a period, from a weather service. */
export interface RadiationSample {
    /** W/m² */
    irradiance: number;
    /** Middle of the period the mean was taken over (ms). */
    time: number;
    source: RadiationSourceName;
}

export interface RadiationProvider {
    readonly name: RadiationSourceName;
    /** How often new values are available. */
    readonly refreshIntervalMs: number;
    fetch(location: Location): Promise<RadiationSample>;
}

const TIMEOUT_MS = 15_000;

async function getJson(url: URL): Promise<unknown> {
    const response = await httpRequest({ method: "GET", url, timeoutMs: TIMEOUT_MS });
    const body = parseJson(response.text);
    if (response.status < 200 || response.status >= 300) {
        const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string"
            ? `: ${(body as { reason: string }).reason}` : "";
        throw new Error(`${url.host} answered HTTP ${response.status}${reason}`);
    }
    if (!body || typeof body !== "object")
        throw new Error(`${url.host} sent an invalid response`);
    return body;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Open-Meteo (open-meteo.com, free for non-commercial use, no key): modelled shortwave
 * radiation of the current 15 minutes (ICON-D2/AROME in Central Europe, interpolated elsewhere).
 */
export class OpenMeteoProvider implements RadiationProvider {
    readonly name = "openmeteo";
    readonly refreshIntervalMs = 15 * 60_000;

    constructor(private readonly baseUrl = "https://api.open-meteo.com") {}

    async fetch(location: Location): Promise<RadiationSample> {
        const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/v1/forecast`);
        url.searchParams.set("latitude", location.latitude.toFixed(4));
        url.searchParams.set("longitude", location.longitude.toFixed(4));
        url.searchParams.set("current", "shortwave_radiation");
        url.searchParams.set("timeformat", "unixtime");
        const body = await getJson(url) as { current?: { time?: unknown; interval?: unknown; shortwave_radiation?: unknown } };
        const current = body.current;
        if (!current || !finite(current.time) || !finite(current.shortwave_radiation))
            throw new Error("Open-Meteo sent no current solar radiation");
        const interval = finite(current.interval) && current.interval > 0 ? current.interval : 900;
        return {
            irradiance: Math.max(0, current.shortwave_radiation),
            time: (current.time - interval / 2) * 1000,
            source: this.name,
        };
    }
}

/**
 * Bright Sky (brightsky.dev): current weather compiled from the observations of the German
 * weather service DWD; solar irradiation measured at the nearest station that records it.
 */
export class BrightSkyProvider implements RadiationProvider {
    readonly name = "brightsky";
    readonly refreshIntervalMs = 10 * 60_000;

    constructor(private readonly baseUrl = "https://api.brightsky.dev") {}

    async fetch(location: Location): Promise<RadiationSample> {
        const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/current_weather`);
        url.searchParams.set("lat", location.latitude.toFixed(4));
        url.searchParams.set("lon", location.longitude.toFixed(4));
        const body = await getJson(url) as { weather?: Record<string, unknown> };
        const weather = body.weather ?? {};
        const timestamp = typeof weather.timestamp === "string" ? Date.parse(weather.timestamp) : Number.NaN;
        if (!Number.isFinite(timestamp))
            throw new Error("Bright Sky sent no current weather");
        // Irradiation in kWh/m² during the previous 10, 30 or 60 minutes.
        for (const minutes of [10, 30, 60]) {
            const energy = weather[`solar_${minutes}`];
            if (finite(energy)) {
                return {
                    irradiance: Math.max(0, energy * 1000 * 60 / minutes),
                    time: timestamp - minutes * 30_000,
                    source: this.name,
                };
            }
        }
        throw new Error("no DWD station with solar radiation measurements nearby");
    }
}

/** Below this clear-sky irradiance (low sun), the ratio measured/clear sky is too uncertain. */
const MIN_CLEAR_SKY_FOR_RATIO = 30;

/**
 * Estimated horizontal illuminance (lx).
 *
 * Without a sample: cloudless sky. With a sample: the ratio of the measured to the clear-sky
 * irradiance at the time of the sample (the cloudiness) is applied to the clear-sky value of
 * now, so the value follows the sun between two queries. Below the horizon: twilight values.
 */
export function estimateIlluminance(now: number, location: Location, sample?: RadiationSample): number {
    const elevation = solarElevation(now, location);
    const twilight = twilightIlluminance(elevation);
    if (elevation <= 0)
        return twilight;
    const clearSky = clearSkyIrradiance(elevation);
    if (!sample)
        return Math.max(clearSky * LUX_PER_WATT, twilight);
    const sampleClearSky = clearSkyIrradiance(solarElevation(sample.time, location));
    if (sampleClearSky < MIN_CLEAR_SKY_FOR_RATIO)
        return Math.max(sample.irradiance * LUX_PER_WATT, twilight);
    const clearness = Math.min(1.3, Math.max(0.02, sample.irradiance / sampleClearSky));
    return clearness * Math.max(clearSky * LUX_PER_WATT, twilight);
}

/** A sample is used this long; afterwards the cloudless sky is assumed until a new one arrives. */
export const MAX_SAMPLE_AGE_MS = 45 * 60_000;
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000];

export interface BrightnessState {
    lux: number;
    /** Where the value comes from. */
    source: RadiationSourceName | "sun";
    /** A weather service is configured but has no current value. */
    fallback: boolean;
}

/** Fetches the irradiance periodically and derives the illuminance for any moment. */
export class BrightnessService {
    private sample: RadiationSample | undefined;
    private nextFetch = 0;
    private failures = 0;
    private fetching: Promise<void> | undefined;
    private lastError: string | undefined;

    constructor(
        private readonly provider: RadiationProvider | undefined,
        private readonly log = new Logger("brightness"),
    ) {}

    get error(): string | undefined {
        return this.lastError;
    }

    /** Fetches a new sample if one is due; never throws. */
    update(now: number, location: Location): Promise<void> {
        if (!this.provider || now < this.nextFetch)
            return Promise.resolve();
        this.fetching ??= this.fetch(this.provider, now, location).finally(() => this.fetching = undefined);
        return this.fetching;
    }

    current(now: number, location: Location): BrightnessState {
        const sample = this.sample && now - this.sample.time <= MAX_SAMPLE_AGE_MS ? this.sample : undefined;
        return {
            lux: Math.round(estimateIlluminance(now, location, sample)),
            source: sample?.source ?? "sun",
            fallback: this.provider !== undefined && sample === undefined,
        };
    }

    private async fetch(provider: RadiationProvider, now: number, location: Location): Promise<void> {
        try {
            const sample = await provider.fetch(location);
            this.sample = sample;
            this.failures = 0;
            this.lastError = undefined;
            // New values are published in fixed intervals; ask shortly after the next one.
            const periodEnd = sample.time + provider.refreshIntervalMs / 2;
            this.nextFetch = Math.max(now + 60_000, Math.min(now + provider.refreshIntervalMs, periodEnd + provider.refreshIntervalMs + 60_000));
            this.log.debug(`${provider.name}: ${sample.irradiance.toFixed(0)} W/m² (${new Date(sample.time).toISOString()})`);
        } catch (error) {
            this.failures++;
            this.lastError = errorMessage(error);
            const delay = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)];
            this.nextFetch = now + delay;
            const text = `${provider.name}: ${this.lastError}`;
            if (this.failures === 1 || this.failures % 10 === 0)
                this.log.warn(`could not get the solar radiation (${text}), retrying in ${delay / 60_000} min`);
            else
                this.log.debug(text);
        }
    }
}
