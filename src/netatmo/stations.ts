import { RawModule, RawStation, StationsDataBody } from "./types";

export type ModuleType =
    /** Base station (indoor): temperature, humidity, CO2, noise, pressure. */
    | "NAMain"
    /** Outdoor module: temperature, humidity. */
    | "NAModule1"
    /** Wind gauge. */
    | "NAModule2"
    /** Rain gauge. */
    | "NAModule3"
    /** Additional indoor module: temperature, humidity, CO2. */
    | "NAModule4";

const MODULE_TYPES: readonly string[] = ["NAMain", "NAModule1", "NAModule2", "NAModule3", "NAModule4"];

export interface Location {
    latitude: number;
    longitude: number;
}

/** Latest values of one module (metric units as delivered by Netatmo). */
export interface ModuleData {
    id: string;
    type: ModuleType;
    name: string;
    reachable: boolean;
    /** Time of the measurement (ms); undefined if the module has no current data. */
    time?: number;
    batteryPercent?: number;
    temperature?: number;
    humidity?: number;
    co2?: number;
    noise?: number;
    /** Pressure at sea level (hPa). */
    pressure?: number;
    /** km/h */
    windStrength?: number;
    /** km/h */
    gustStrength?: number;
    windAngle?: number;
    /** Rain since the previous measurement (mm). */
    rain?: number;
    rainHour?: number;
    rainDay?: number;
}

export interface StationData {
    id: string;
    name: string;
    location?: Location;
    main: ModuleData;
    modules: ModuleData[];
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseLocation(location: unknown): Location | undefined {
    if (!Array.isArray(location) || location.length < 2)
        return undefined;
    const longitude = finite(location[0]);
    const latitude = finite(location[1]);
    if (longitude === undefined || latitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
        return undefined;
    return { latitude, longitude };
}

function parseModule(raw: RawModule, fallbackName: string): ModuleData | undefined {
    if (typeof raw._id !== "string" || !raw._id || !MODULE_TYPES.includes(raw.type ?? ""))
        return undefined;
    const data = raw.dashboard_data;
    const time = finite(data?.time_utc);
    return {
        id: raw._id,
        type: raw.type as ModuleType,
        name: raw.module_name?.trim() || fallbackName,
        reachable: raw.reachable !== false && data !== undefined,
        time: time !== undefined ? time * 1000 : undefined,
        batteryPercent: finite(raw.battery_percent),
        temperature: finite(data?.Temperature),
        humidity: finite(data?.Humidity),
        co2: finite(data?.CO2),
        noise: finite(data?.Noise),
        pressure: finite(data?.Pressure),
        windStrength: finite(data?.WindStrength),
        gustStrength: finite(data?.GustStrength),
        windAngle: finite(data?.WindAngle),
        rain: finite(data?.Rain),
        rainHour: finite(data?.sum_rain_1),
        rainDay: finite(data?.sum_rain_24),
    };
}

const DEFAULT_NAMES: Record<ModuleType, string> = {
    NAMain: "Indoor",
    NAModule1: "Outdoor",
    NAModule2: "Wind",
    NAModule3: "Rain",
    NAModule4: "Indoor module",
};

function parseStation(raw: RawStation): StationData | undefined {
    const main = parseModule(raw, DEFAULT_NAMES.NAMain);
    if (!main || main.type !== "NAMain")
        return undefined;
    const modules = (Array.isArray(raw.modules) ? raw.modules : [])
        .map((module) => parseModule(module, DEFAULT_NAMES[(module.type ?? "NAModule4") as ModuleType] ?? "Module"))
        .filter((module): module is ModuleData => module !== undefined && module.type !== "NAMain");
    return {
        id: main.id,
        name: raw.station_name?.trim() || raw.home_name?.trim() || main.name,
        location: parseLocation(raw.place?.location),
        main,
        modules,
    };
}

/**
 * Reads the stations of the account from a /getstationsdata response. Stations the user only
 * follows as favourites are skipped (they are not requested, but may be included anyway).
 */
export function parseStations(body: StationsDataBody): StationData[] {
    const devices = Array.isArray(body.devices) ? body.devices : [];
    return devices
        .filter((device) => device && device.favorite !== true)
        .map(parseStation)
        .filter((station): station is StationData => station !== undefined);
}

/** All modules of a station including the base station. */
export function allModules(station: StationData): ModuleData[] {
    return [station.main, ...station.modules];
}

/** Values older than this are not used (the station reports every 5–10 minutes). */
export const STALE_AFTER_MS = 30 * 60_000;

/** True if the module is reachable and its last measurement is recent. */
export function isFresh(module: ModuleData | undefined, now: number): module is ModuleData {
    return module !== undefined && module.reachable && module.time !== undefined && now - module.time <= STALE_AFTER_MS;
}

export function firstModule(station: StationData, type: ModuleType): ModuleData | undefined {
    return station.modules.find((module) => module.type === type);
}
