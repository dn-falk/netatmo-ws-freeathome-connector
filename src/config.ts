import { createHash } from "node:crypto";

export type SourceMode = "auto" | "own" | "public" | "off";
export type BrightnessSource = "openmeteo" | "brightsky" | "sun" | "off";
export type IndoorSensorMode = "separate" | "combined" | "off";
export type WindValue = "gust" | "average";
export type NameLanguage = "de" | "en";

export interface Settings {
    clientId: string;
    clientSecret: string;
    /** Refresh token to start with: the stored (rotated) one if it belongs to the entered one. */
    refreshToken: string;
    /** Fingerprint of the refresh token entered by the user, see {@link TokenState}. */
    tokenOrigin: string;
    indoorSensors: IndoorSensorMode;
    outdoorHumidity: boolean;
    /** Normalised names of modules that are not created in free@home. */
    excluded: string[];
    nameLanguage: NameLanguage;
    temperatureSource: SourceMode;
    rainSource: SourceMode;
    windSource: SourceMode;
    brightnessSource: BrightnessSource;
    windValue: WindValue;
    rainHoldMs: number;
    publicRadiusKm: number;
    rainMinStations: number;
    location?: { latitude: number; longitude: number };
    maxPollIntervalMs: number;
    debug: boolean;
}

export interface Message {
    en: string;
    de: string;
}

export type ConfigResult =
    | { ok: true; settings: Settings }
    | { ok: false; problems: Message[] };

/**
 * Netatmo replaces the refresh token on every renewal and invalidates the old one. The addon
 * therefore stores the current token in the hidden parameter `tokenState` of its configuration.
 * `origin` is the fingerprint of the token the user entered: if the user enters a new token,
 * the stored one no longer belongs to it and is ignored.
 */
export interface TokenState {
    origin: string;
    refreshToken: string;
}

export const TOKEN_GROUP = "netatmo";
export const TOKEN_STATE_ITEM = "tokenState";

const SOURCE_MODES: readonly SourceMode[] = ["auto", "own", "public", "off"];
const BRIGHTNESS_SOURCES: readonly BrightnessSource[] = ["openmeteo", "brightsky", "sun", "off"];
const INDOOR_MODES: readonly IndoorSensorMode[] = ["separate", "combined", "off"];

type Items = Record<string, unknown>;

export function groupItems(configuration: unknown, group: string): Items {
    if (!configuration || typeof configuration !== "object")
        return {};
    const entry = (configuration as Record<string, unknown>)[group];
    if (!entry || typeof entry !== "object")
        return {};
    const items = (entry as Record<string, unknown>).items;
    return items && typeof items === "object" ? items as Items : {};
}

function stringValue(value: unknown): string | undefined {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (typeof value === "number")
        return String(value);
    return undefined;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
    const number = typeof value === "number" ? value
        : typeof value === "string" && value.trim() !== "" ? Number(value.replace(",", ".")) : Number.NaN;
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(max, Math.max(min, number));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean")
        return value;
    if (value === "true" || value === 1 || value === "1")
        return true;
    if (value === "false" || value === 0 || value === "0")
        return false;
    return fallback;
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
    const text = stringValue(value);
    return options.find((option) => option === text) ?? fallback;
}

/** Short fingerprint of a refresh token (the token itself is not repeated in the configuration). */
export function tokenFingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").substring(0, 16);
}

export function parseTokenState(value: unknown): TokenState | undefined {
    const text = stringValue(value);
    if (!text)
        return undefined;
    try {
        const parsed = JSON.parse(text) as Partial<TokenState>;
        if (typeof parsed.origin === "string" && typeof parsed.refreshToken === "string" && parsed.refreshToken)
            return { origin: parsed.origin, refreshToken: parsed.refreshToken };
    } catch {
        // ignore a damaged value, the entered token is used then
    }
    return undefined;
}

/** Splits "Kitchen, Bedroom" into normalised names. */
export function parseExcludedNames(text: string | undefined): string[] {
    return (text ?? "").split(",").map(normaliseName).filter((name) => name !== "");
}

export function normaliseName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCoordinate(text: string | undefined, limit: number): number | undefined | null {
    if (!text)
        return undefined;
    const number = Number(text.replace(",", "."));
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/** Reads the addon configuration (as sent by the System Access Point) into {@link Settings}. */
export function parseConfiguration(configuration: unknown): ConfigResult {
    const netatmo = groupItems(configuration, "netatmo");
    const devices = groupItems(configuration, "devices");
    const weather = groupItems(configuration, "weather");
    const advanced = groupItems(configuration, "advanced");
    const problems: Message[] = [];

    const clientId = stringValue(netatmo.clientId);
    if (!clientId)
        problems.push({ en: "client ID is missing", de: "Client ID fehlt" });
    const clientSecret = stringValue(netatmo.clientSecret);
    if (!clientSecret)
        problems.push({ en: "client secret is missing", de: "Client Secret fehlt" });
    const enteredToken = stringValue(netatmo.refreshToken);
    if (!enteredToken)
        problems.push({ en: "refresh token is missing", de: "Refresh Token fehlt" });

    const latitude = parseCoordinate(stringValue(weather.latitude), 90);
    const longitude = parseCoordinate(stringValue(weather.longitude), 180);
    if (latitude === null)
        problems.push({ en: "invalid latitude", de: "ungültiger Breitengrad" });
    if (longitude === null)
        problems.push({ en: "invalid longitude", de: "ungültiger Längengrad" });
    if ((latitude === undefined) !== (longitude === undefined) && latitude !== null && longitude !== null)
        problems.push({ en: "enter both latitude and longitude", de: "Breiten- und Längengrad angeben" });

    if (problems.length > 0 || !clientId || !clientSecret || !enteredToken)
        return { ok: false, problems };

    const tokenOrigin = tokenFingerprint(enteredToken);
    const stored = parseTokenState(netatmo[TOKEN_STATE_ITEM]);
    const refreshToken = stored && stored.origin === tokenOrigin ? stored.refreshToken : enteredToken;

    return {
        ok: true,
        settings: {
            clientId,
            clientSecret,
            refreshToken,
            tokenOrigin,
            indoorSensors: choice(devices.indoorSensors, INDOOR_MODES, "separate"),
            outdoorHumidity: booleanValue(devices.outdoorHumidity, true),
            excluded: parseExcludedNames(stringValue(devices.excludedModules)),
            nameLanguage: choice(devices.deviceNameLanguage, ["de", "en"] as const, "de"),
            temperatureSource: choice(weather.temperatureSource, SOURCE_MODES, "auto"),
            rainSource: choice(weather.rainSource, SOURCE_MODES, "auto"),
            windSource: choice(weather.windSource, SOURCE_MODES, "auto"),
            brightnessSource: choice(weather.brightnessSource, BRIGHTNESS_SOURCES, "openmeteo"),
            windValue: choice(weather.windValue, ["gust", "average"] as const, "gust"),
            rainHoldMs: Math.round(numberValue(weather.rainHold, 20, 0, 180) * 60_000),
            publicRadiusKm: numberValue(weather.publicRadius, 5, 1, 25),
            rainMinStations: Math.round(numberValue(weather.rainMinStations, 2, 1, 5)),
            location: latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null
                ? { latitude, longitude } : undefined,
            maxPollIntervalMs: Math.round(numberValue(advanced.pollInterval, 10, 2, 60) * 60_000),
            debug: booleanValue(advanced.debug, false),
        },
    };
}

/**
 * Key that decides whether a new configuration needs a restart of the connection. The stored
 * token is not part of it: the addon writes it itself after every renewal.
 */
export function restartKey(result: ConfigResult): string {
    if (!result.ok)
        return JSON.stringify(result);
    const { refreshToken: _ignored, ...rest } = result.settings;
    return JSON.stringify(rest);
}

/** Returns a copy of the configuration with the stored token replaced. */
export function withTokenState(configuration: unknown, state: TokenState): Record<string, unknown> {
    const copy = configuration && typeof configuration === "object"
        ? JSON.parse(JSON.stringify(configuration)) as Record<string, unknown>
        : {};
    const group = copy[TOKEN_GROUP] && typeof copy[TOKEN_GROUP] === "object"
        ? copy[TOKEN_GROUP] as Record<string, unknown>
        : {};
    const items = group.items && typeof group.items === "object" ? group.items as Record<string, unknown> : {};
    items[TOKEN_STATE_ITEM] = JSON.stringify(state);
    group.items = items;
    copy[TOKEN_GROUP] = group;
    return copy;
}
