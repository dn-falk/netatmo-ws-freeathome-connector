import { Location, parseLocation } from "./stations";
import { BoundingBox, PublicMeasure, RawPublicStation } from "./types";

/** A station of the public Netatmo weather map with the values the addon uses. */
export interface PublicStation {
    id: string;
    location: Location;
    distanceKm: number;
    temperature?: { value: number; time: number };
    rain?: { live: number; hour?: number; time: number };
    /** km/h */
    wind?: { strength: number; gust: number; time: number };
}

const EARTH_RADIUS_KM = 6371;
/** Public values older than this are ignored (stations upload every 10 minutes). */
export const PUBLIC_STALE_AFTER_MS = 30 * 60_000;

const toRadians = (degrees: number) => degrees * Math.PI / 180;

export function distanceKm(a: Location, b: Location): number {
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Area around a location that contains the circle with the given radius. */
export function boundingBox(center: Location, radiusKm: number): BoundingBox {
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos(toRadians(center.latitude))));
    return {
        latNE: Math.min(90, center.latitude + dLat),
        lonNE: Math.min(180, center.longitude + dLon),
        latSW: Math.max(-90, center.latitude - dLat),
        lonSW: Math.max(-180, center.longitude - dLon),
    };
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Latest value of a type from the "res" table of a public module. */
function latestValue(measure: PublicMeasure, type: string): { value: number; time: number } | undefined {
    const index = Array.isArray(measure.type) ? measure.type.indexOf(type) : -1;
    if (index < 0 || !measure.res || typeof measure.res !== "object")
        return undefined;
    let latest: { value: number; time: number } | undefined;
    for (const [time, values] of Object.entries(measure.res)) {
        const seconds = Number(time);
        const value = Array.isArray(values) ? finite(values[index]) : undefined;
        if (Number.isFinite(seconds) && value !== undefined && (!latest || seconds * 1000 > latest.time))
            latest = { value, time: seconds * 1000 };
    }
    return latest;
}

function parsePublicStation(raw: RawPublicStation, center: Location): PublicStation | undefined {
    const location = parseLocation(raw.place?.location);
    if (typeof raw._id !== "string" || !location)
        return undefined;
    const station: PublicStation = { id: raw._id, location, distanceKm: distanceKm(center, location) };
    for (const measure of Object.values(raw.measures ?? {})) {
        if (!measure || typeof measure !== "object")
            continue;
        const temperature = latestValue(measure, "temperature");
        if (temperature)
            station.temperature = temperature;
        const rainTime = finite(measure.rain_timeutc);
        const rainLive = finite(measure.rain_live);
        if (rainTime !== undefined && rainLive !== undefined)
            station.rain = { live: rainLive, hour: finite(measure.rain_60min), time: rainTime * 1000 };
        const windTime = finite(measure.wind_timeutc);
        const windStrength = finite(measure.wind_strength);
        if (windTime !== undefined && windStrength !== undefined)
            station.wind = { strength: windStrength, gust: finite(measure.gust_strength) ?? windStrength, time: windTime * 1000 };
    }
    return station;
}

/**
 * Reads a /getpublicdata response: stations within the radius, nearest first. Own stations
 * (they may be public as well) are left out.
 */
export function parsePublicStations(raw: RawPublicStation[], center: Location, radiusKm: number, ownIds: ReadonlySet<string>): PublicStation[] {
    return raw
        .map((station) => parsePublicStation(station, center))
        .filter((station): station is PublicStation => station !== undefined
            && station.distanceKm <= radiusKm && !ownIds.has(station.id))
        .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function median(values: number[]): number | undefined {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const isRecent = (time: number, now: number) => now - time <= PUBLIC_STALE_AFTER_MS && time - now <= PUBLIC_STALE_AFTER_MS;

/** Number of nearest stations whose values are combined. */
export const PUBLIC_TEMPERATURE_STATIONS = 5;
export const PUBLIC_WIND_STATIONS = 3;
export const PUBLIC_RAIN_STATIONS = 5;

export interface PublicTemperature {
    value: number;
    stations: number;
    time: number;
}

/** Median temperature of the nearest stations with current values. */
export function publicTemperature(stations: PublicStation[], now: number): PublicTemperature | undefined {
    const used = stations.filter((station) => station.temperature && isRecent(station.temperature.time, now))
        .slice(0, PUBLIC_TEMPERATURE_STATIONS);
    const value = median(used.map((station) => station.temperature?.value as number));
    if (value === undefined)
        return undefined;
    return { value, stations: used.length, time: Math.max(...used.map((station) => station.temperature?.time as number)) };
}

export interface PublicWind {
    /** km/h */
    strength: number;
    /** km/h */
    gust: number;
    stations: number;
    time: number;
}

/** Median wind and gust strength of the nearest wind gauges with current values. */
export function publicWind(stations: PublicStation[], now: number): PublicWind | undefined {
    const used = stations.filter((station) => station.wind && isRecent(station.wind.time, now)).slice(0, PUBLIC_WIND_STATIONS);
    const strength = median(used.map((station) => station.wind?.strength as number));
    const gust = median(used.map((station) => station.wind?.gust as number));
    if (strength === undefined || gust === undefined)
        return undefined;
    return { strength, gust, stations: used.length, time: Math.max(...used.map((station) => station.wind?.time as number)) };
}

export interface PublicRain {
    raining: boolean;
    /** Rain gauges that measured rain in their last interval. */
    rainingStations: number;
    stations: number;
    /** Stations needed for "raining" (the setting, limited to the available stations). */
    required: number;
    time: number;
}

/**
 * Rain from the nearest rain gauges: it rains if at least `minStations` of them (or all, if
 * there are fewer) measured rain in their last interval.
 */
export function publicRain(stations: PublicStation[], now: number, minStations: number): PublicRain | undefined {
    const used = stations.filter((station) => station.rain && isRecent(station.rain.time, now)).slice(0, PUBLIC_RAIN_STATIONS);
    if (used.length === 0)
        return undefined;
    const raining = used.filter((station) => (station.rain?.live ?? 0) > 0);
    const required = Math.max(1, Math.min(minStations, used.length));
    const times = (raining.length >= required ? raining : used).map((station) => station.rain?.time as number);
    return {
        raining: raining.length >= required,
        rainingStations: raining.length,
        stations: used.length,
        required,
        time: Math.max(...times),
    };
}
