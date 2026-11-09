import { createHmac, timingSafeEqual } from "node:crypto";

import { ModuleData } from "./stations";

/**
 * Port on which the addon receives the webhooks of Netatmo. It has to be declared in
 * free-at-home-metadata.json (accessControl.networkPorts), so it cannot be a setting.
 */
export const WEBHOOK_PORT = 8765;

/** Header with the HMAC-SHA256 signature of the request body (lowercase hex, key: client secret). */
export const SIGNATURE_HEADER = "x-netatmo-secret";

/** Signature Netatmo sends for a webhook body. */
export function webhookSignature(rawBody: Buffer | string, clientSecret: string): string {
    return createHmac("sha256", clientSecret).update(rawBody).digest("hex");
}

/** True if `signature` is the signature of the body made with the client secret of the app. */
export function verifySignature(rawBody: Buffer, clientSecret: string, signature: string | undefined): boolean {
    const text = signature?.trim() ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(text))
        return false;
    const expected = createHmac("sha256", clientSecret).update(rawBody).digest();
    return timingSafeEqual(Buffer.from(text, "hex"), expected);
}

/** Measurements of a module in a webhook, in the units of {@link ModuleData} (°C, %, ppm, hPa, km/h, mm). */
export type LiveValues = Partial<Pick<ModuleData,
    "temperature" | "humidity" | "co2" | "noise" | "pressure" | "windStrength" | "gustStrength" | "windAngle" | "rain" | "rainHour" | "rainDay">>;

/** One entry of `extra_params.modules` of a device event. */
export interface LiveModule {
    /** MAC address, lowercase. */
    id: string;
    /** Latest time Netatmo gives for the module (last_seen, last_message; ms). */
    time?: number;
    /** false if Netatmo reports that the module is not reachable. */
    reachable?: boolean;
    values: LiveValues;
}

export interface WebhookEvent {
    /** e.g. device_event, topology_changed, webhook_activation, webhook_deletion */
    pushType: string;
    userId?: string;
    homeId?: string;
    /** MAC address of the gateway (lowercase), for weather stations the base station. */
    deviceId?: string;
    modules: LiveModule[];
}

interface Field {
    /** Names in the webhook (first one found is used): the new webhooks and /homestatus. */
    keys: string[];
    field: keyof LiveValues;
    /** Plausible range; values outside are ignored. */
    min: number;
    max: number;
}

/**
 * Measurements of the weather station modules in device events. The names differ from
 * /getstationsdata (e.g. "pressure_sea" instead of "Pressure", "gustspeed" instead of
 * "GustStrength"); the units are those of the rest of the API.
 */
const FIELDS: readonly Field[] = [
    { keys: ["temperature"], field: "temperature", min: -80, max: 80 },
    { keys: ["humidity"], field: "humidity", min: 0, max: 100 },
    { keys: ["co2"], field: "co2", min: 0, max: 20_000 },
    { keys: ["noise_current", "noise"], field: "noise", min: 0, max: 200 },
    { keys: ["pressure_sea", "pressure"], field: "pressure", min: 500, max: 1_200 },
    { keys: ["windspeed", "wind_strength"], field: "windStrength", min: 0, max: 500 },
    { keys: ["gustspeed", "gust_strength"], field: "gustStrength", min: 0, max: 500 },
    { keys: ["windangle", "wind_angle"], field: "windAngle", min: -1, max: 360 },
    { keys: ["rain"], field: "rain", min: 0, max: 1_000 },
    { keys: ["sum_rain_1"], field: "rainHour", min: 0, max: 1_000 },
    { keys: ["sum_rain_24"], field: "rainDay", min: 0, max: 5_000 },
];

const TIME_KEYS = ["last_seen", "last_message", "time_utc"];

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseModule(raw: unknown): LiveModule | undefined {
    const entry = record(raw);
    const id = text(entry?.id)?.toLowerCase();
    if (!entry || !id)
        return undefined;
    const values: LiveValues = {};
    for (const { keys, field, min, max } of FIELDS) {
        for (const key of keys) {
            const value = finite(entry[key]);
            if (value === undefined)
                continue;
            if (value >= min && value <= max)
                values[field] = value;
            break;
        }
    }
    const times = TIME_KEYS.map((key) => finite(entry[key])).filter((time): time is number => time !== undefined && time > 0);
    return {
        id,
        time: times.length > 0 ? Math.max(...times) * 1000 : undefined,
        reachable: typeof entry.reachable === "boolean" ? entry.reachable : undefined,
        values,
    };
}

/** Reads a webhook body; undefined if it is not a Netatmo event. */
export function parseWebhookEvent(body: unknown): WebhookEvent | undefined {
    const event = record(body);
    const pushType = text(event?.push_type);
    if (!event || !pushType)
        return undefined;
    const modules = record(event.extra_params)?.modules;
    return {
        pushType,
        userId: text(event.user_id),
        homeId: text(event.home_id),
        deviceId: text(event.device_id)?.toLowerCase(),
        modules: (Array.isArray(modules) ? modules : [])
            .map(parseModule)
            .filter((module): module is LiveModule => module !== undefined),
    };
}

/** Number of measurements in the values. */
export function valueCount(values: LiveValues): number {
    return Object.values(values).filter((value) => value !== undefined).length;
}
