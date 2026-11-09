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
    /** Public URL for the webhooks of Netatmo; undefined: the values are only queried. */
    webhookUrl?: string;
    /** URL the addon registered with Netatmo (hidden parameter written by the addon itself). */
    registeredWebhookUrl?: string;
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
export const WEBHOOK_GROUP = "webhook";
export const WEBHOOK_REGISTERED_ITEM = "registeredUrl";

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

/** Checks the webhook URL: undefined if empty, null if invalid. */
export function parseWebhookUrl(text: string | undefined): string | undefined | null {
    if (!text)
        return undefined;
    try {
        const url = new URL(text);
        return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" ? url.href : null;
    } catch {
        return null;
    }
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
    const webhook = groupItems(configuration, WEBHOOK_GROUP);
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
    const webhookUrl = parseWebhookUrl(stringValue(webhook.webhookUrl));
    if (webhookUrl === null)
        problems.push({ en: "invalid webhook URL (e.g. https://netatmo.example.com/)", de: "ungültige Webhook-URL (z. B. https://netatmo.example.com/)" });

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
            webhookUrl: webhookUrl ?? undefined,
            registeredWebhookUrl: stringValue(webhook[WEBHOOK_REGISTERED_ITEM]),
            debug: booleanValue(advanced.debug, false),
        },
    };
}

/**
 * Key that decides whether a new configuration needs a restart of the connection. The stored
 * token and the registered webhook URL are not part of it: the addon writes them itself.
 */
export function restartKey(result: ConfigResult): string {
    if (!result.ok)
        return JSON.stringify(result);
    const { refreshToken: _token, registeredWebhookUrl: _webhook, ...rest } = result.settings;
    return JSON.stringify(rest);
}

/** Returns a copy of the configuration with one item replaced (an empty string clears it). */
export function withItem(configuration: unknown, groupName: string, item: string, value: string): Record<string, unknown> {
    const copy = configuration && typeof configuration === "object"
        ? JSON.parse(JSON.stringify(configuration)) as Record<string, unknown>
        : {};
    const group = copy[groupName] && typeof copy[groupName] === "object"
        ? copy[groupName] as Record<string, unknown>
        : {};
    const items = group.items && typeof group.items === "object" ? group.items as Record<string, unknown> : {};
    items[item] = value;
    group.items = items;
    copy[groupName] = group;
    return copy;
}

/** Returns a copy of the configuration with the stored token replaced. */
export function withTokenState(configuration: unknown, state: TokenState): Record<string, unknown> {
    return withItem(configuration, TOKEN_GROUP, TOKEN_STATE_ITEM, JSON.stringify(state));
}

/** Returns a copy of the configuration with the webhook URL registered by the addon. */
export function withRegisteredWebhook(configuration: unknown, url: string | undefined): Record<string, unknown> {
    return withItem(configuration, WEBHOOK_GROUP, WEBHOOK_REGISTERED_ITEM, url ?? "");
}
