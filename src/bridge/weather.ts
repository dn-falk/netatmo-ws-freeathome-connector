import { SourceMode, WindValue } from "../config";
import { kmhToMs } from "../fah/datapoints";
import { PublicStation, publicRain, publicTemperature, publicWind } from "../netatmo/publicData";
import { ModuleData, ModuleType, StationData, firstModule, isFresh } from "../netatmo/stations";
import { PublicDataKind } from "../netatmo/types";

export interface WeatherSettings {
    temperatureSource: SourceMode;
    rainSource: SourceMode;
    windSource: SourceMode;
    windValue: WindValue;
    rainHoldMs: number;
    rainMinStations: number;
}

/** Stations of the public weather map around a station, per kind of data (if fetched). */
export type PublicSnapshot = Partial<Record<PublicDataKind, PublicStation[]>>;

export type SourceInfo =
    | { kind: "own"; module: string }
    | { kind: "public"; stations: number; raining?: number; required?: number }
    | { kind: "none" }
    | { kind: "off" };

export interface WeatherValues {
    /** °C */
    outdoorTemperature?: number;
    /** m/s */
    windSpeed?: number;
    raining?: boolean;
}

export interface WeatherResult {
    values: WeatherValues;
    sources: Record<PublicDataKind, SourceInfo>;
}

const OWN_MODULE: Record<PublicDataKind, ModuleType> = {
    temperature: "NAModule1",
    rain: "NAModule3",
    wind: "NAModule2",
};

function sourceMode(settings: WeatherSettings, kind: PublicDataKind): SourceMode {
    return kind === "temperature" ? settings.temperatureSource : kind === "rain" ? settings.rainSource : settings.windSource;
}

function hasValue(module: ModuleData, kind: PublicDataKind): boolean {
    switch (kind) {
        case "temperature":
            return module.temperature !== undefined;
        case "rain":
            return module.rain !== undefined;
        case "wind":
            return module.windStrength !== undefined;
    }
}

/** The module of the own station that delivers the value, if it is usable now. */
function ownModule(station: StationData, kind: PublicDataKind, settings: WeatherSettings, now: number): ModuleData | undefined {
    const mode = sourceMode(settings, kind);
    if (mode !== "auto" && mode !== "own")
        return undefined;
    const module = firstModule(station, OWN_MODULE[kind]);
    return isFresh(module, now) && hasValue(module, kind) ? module : undefined;
}

/** Kinds of public data needed for a station (own module missing, stale or not wanted). */
export function publicKindsNeeded(station: StationData, settings: WeatherSettings, now: number): PublicDataKind[] {
    return (["temperature", "rain", "wind"] as const).filter((kind) => {
        const mode = sourceMode(settings, kind);
        return mode === "public" || (mode === "auto" && !ownModule(station, kind, settings, now));
    });
}

/**
 * Outdoor values of the free@home weather station of one Netatmo station. Keeps the time of the
 * last rain, so the rain alarm stays on for the configured time after the last measured rain.
 */
export class StationWeather {
    private lastRainAt: number | undefined;

    compute(station: StationData, publicData: PublicSnapshot, settings: WeatherSettings, now: number): WeatherResult {
        const values: WeatherValues = {};
        const sources = {} as Record<PublicDataKind, SourceInfo>;

        // Temperature
        const outdoor = ownModule(station, "temperature", settings, now);
        const publicTemp = settings.temperatureSource === "auto" || settings.temperatureSource === "public"
            ? publicTemperature(publicData.temperature ?? [], now) : undefined;
        if (settings.temperatureSource === "off") {
            sources.temperature = { kind: "off" };
        } else if (outdoor) {
            values.outdoorTemperature = outdoor.temperature;
            sources.temperature = { kind: "own", module: outdoor.name };
        } else if (publicTemp && settings.temperatureSource !== "own") {
            values.outdoorTemperature = Math.round(publicTemp.value * 10) / 10;
            sources.temperature = { kind: "public", stations: publicTemp.stations };
        } else {
            sources.temperature = { kind: "none" };
        }

        // Wind
        const windModule = ownModule(station, "wind", settings, now);
        const gust = settings.windValue === "gust";
        if (settings.windSource === "off") {
            sources.wind = { kind: "off" };
        } else if (windModule) {
            const kmh = gust ? windModule.gustStrength ?? windModule.windStrength : windModule.windStrength;
            values.windSpeed = kmhToMs(kmh as number);
            sources.wind = { kind: "own", module: windModule.name };
        } else {
            const wind = settings.windSource !== "own" ? publicWind(publicData.wind ?? [], now) : undefined;
            if (wind) {
                values.windSpeed = kmhToMs(gust ? wind.gust : wind.strength);
                sources.wind = { kind: "public", stations: wind.stations };
            } else {
                sources.wind = { kind: "none" };
            }
        }

        // Rain
        if (settings.rainSource === "off") {
            sources.rain = { kind: "off" };
        } else {
            const rainModule = ownModule(station, "rain", settings, now);
            let measured: boolean | undefined;
            if (rainModule) {
                measured = (rainModule.rain ?? 0) > 0;
                if (measured)
                    this.rememberRain(rainModule.time as number);
                sources.rain = { kind: "own", module: rainModule.name };
            } else {
                const rain = settings.rainSource !== "own" ? publicRain(publicData.rain ?? [], now, settings.rainMinStations) : undefined;
                if (rain) {
                    measured = rain.raining;
                    if (measured)
                        this.rememberRain(rain.time);
                    sources.rain = { kind: "public", stations: rain.stations, raining: rain.rainingStations, required: rain.required };
                } else {
                    sources.rain = { kind: "none" };
                }
            }
            const holding = this.lastRainAt !== undefined && now - this.lastRainAt < settings.rainHoldMs;
            // Without data, a running alarm is kept until the hold time is over; after that the
            // last value stays as it is.
            values.raining = measured === undefined ? (holding ? true : undefined) : measured || holding;
        }
        return { values, sources };
    }

    private rememberRain(time: number): void {
        if (this.lastRainAt === undefined || time > this.lastRainAt)
            this.lastRainAt = time;
    }
}
