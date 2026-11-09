import * as http from "node:http";
import { AddressInfo } from "node:net";

import { RawModule, RawPublicStation, RawStation } from "../../src/netatmo/types";
import { parseJson } from "../../src/http";
import { SIGNATURE_HEADER, webhookSignature } from "../../src/netatmo/webhook";

export interface SimulatedModule {
    id: string;
    type: "NAModule1" | "NAModule2" | "NAModule3" | "NAModule4";
    name: string;
    reachable?: boolean;
    battery?: number;
    /** Measurement age in seconds (default 60). */
    age?: number;
    values: Record<string, number>;
}

export interface SimulatedStation {
    id: string;
    name: string;
    /** [longitude, latitude] */
    location: [number, number];
    mainName?: string;
    /** Measurement age of the base station in seconds (default 60). */
    age?: number;
    values: Record<string, number>;
    modules: SimulatedModule[];
}

export interface SimulatedPublicStation {
    id: string;
    /** [longitude, latitude] */
    location: [number, number];
    temperature?: number;
    rainLive?: number;
    wind?: { strength: number; gust: number };
    /** Measurement age in seconds (default 120). */
    age?: number;
}

export interface NetatmoSimulatorOptions {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    stations?: SimulatedStation[];
    publicStations?: SimulatedPublicStation[];
    /** Solar radiation (W/m²) reported by the simulated Open-Meteo and Bright Sky. */
    radiation?: number;
    /** Lifetime of access tokens in seconds. */
    tokenLifetime?: number;
    log?: (message: string) => void;
}

export interface RecordedRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    authorization?: string;
    form?: Record<string, string>;
    json?: unknown;
}

export interface DeliveredWebhook {
    status: number;
    body: string;
}

/**
 * Simulates the Netatmo cloud (OAuth2 token endpoint with rotating refresh tokens,
 * /api/getstationsdata, /api/getpublicdata) and the weather services Open-Meteo and Bright Sky.
 */
export class NetatmoSimulator {
    readonly clientId: string;
    readonly clientSecret: string;
    stations: SimulatedStation[];
    publicStations: SimulatedPublicStation[];
    radiation: number;
    readonly requests: RecordedRequest[] = [];
    /** Answer every data request with this HTTP status and Netatmo error (tests of error handling). */
    failWith: { status: number; code: number; message: string } | undefined;
    /** Weather services answer with HTTP 503. */
    weatherServiceDown = false;
    /** Every answer is delayed by this many milliseconds (a slow cloud). */
    responseDelayMs = 0;
    /** Webhook URLs registered for the user (Webhooks API). */
    webhooks: string[] = [];
    /** Answer requests to the Webhooks API with this HTTP status (e.g. 403: app not allowed). */
    webhooksFailWith: number | undefined;
    private validRefreshTokens = new Set<string>();
    private validAccessTokens = new Set<string>();
    private tokenCounter = 0;
    private readonly tokenLifetime: number;
    private readonly server = http.createServer((req, res) => this.handle(req, res));

    constructor(private readonly options: NetatmoSimulatorOptions = {}) {
        this.clientId = options.clientId ?? "client-id";
        this.clientSecret = options.clientSecret ?? "client-secret";
        this.validRefreshTokens.add(options.refreshToken ?? "refresh-0");
        this.stations = options.stations ?? [defaultStation()];
        this.publicStations = options.publicStations ?? [];
        this.radiation = options.radiation ?? 400;
        this.tokenLifetime = options.tokenLifetime ?? 10_800;
    }

    get initialRefreshToken(): string {
        return this.options.refreshToken ?? "refresh-0";
    }

    /** The refresh token that is valid now (Netatmo invalidates the previous one on every renewal). */
    get currentRefreshToken(): string | undefined {
        return [...this.validRefreshTokens][0];
    }

    /** Base URL once the simulator listens. */
    url = "";

    async listen(port = 0, host = "127.0.0.1"): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
        this.url = `http://${host}:${(this.server.address() as AddressInfo).port}`;
        return this.url;
    }

    async close(): Promise<void> {
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** Invalidates all access tokens (as if they had expired). */
    expireAccessTokens(): void {
        this.validAccessTokens.clear();
    }

    /** Invalidates the refresh token (e.g. the app was deleted on dev.netatmo.com). */
    revokeRefreshTokens(): void {
        this.validRefreshTokens.clear();
        this.validAccessTokens.clear();
    }

    requestsTo(path: string): RecordedRequest[] {
        return this.requests.filter((request) => request.path === path);
    }

    private log(message: string): void {
        this.options.log?.(message);
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const body = Buffer.concat(chunks).toString("utf8");
            const request: RecordedRequest = {
                method: req.method ?? "GET",
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                authorization: req.headers.authorization,
                form: req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
                    ? Object.fromEntries(new URLSearchParams(body)) : undefined,
                json: req.headers["content-type"]?.startsWith("application/json") ? parseJson(body) : undefined,
            };
            this.requests.push(request);
            this.log(`${request.method} ${url.pathname}${url.search}`);
            const json = (status: number, payload: unknown) => {
                const send = () => {
                    res.writeHead(status, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(payload));
                };
                if (this.responseDelayMs > 0)
                    setTimeout(send, this.responseDelayMs);
                else
                    send();
            };

            switch (url.pathname) {
                case "/oauth2/token":
                    return this.token(request, json);
                case "/webhooks/v1/":
                    return this.webhooksApi(request, json);
                case "/api/getstationsdata":
                case "/api/getpublicdata": {
                    const token = request.authorization?.replace(/^Bearer /, "");
                    if (!token || !this.validAccessTokens.has(token))
                        return json(403, { error: { code: 3, message: "Access token expired" } });
                    if (this.failWith)
                        return json(this.failWith.status, { error: { code: this.failWith.code, message: this.failWith.message } });
                    const now = Date.now() / 1000;
                    if (url.pathname === "/api/getstationsdata")
                        return json(200, { body: { devices: this.stations.map((station) => rawStation(station, now)), user: {} }, status: "ok", time_server: Math.round(now) });
                    return json(200, { body: this.publicData(request.query, now), status: "ok", time_server: Math.round(now) });
                }
                case "/v1/forecast": {
                    if (this.weatherServiceDown)
                        return json(503, { error: true, reason: "service unavailable" });
                    const slot = Math.floor(Date.now() / 900_000) * 900;
                    return json(200, {
                        latitude: Number(request.query.latitude),
                        longitude: Number(request.query.longitude),
                        current_units: { time: "unixtime", interval: "seconds", shortwave_radiation: "W/m²" },
                        current: { time: slot, interval: 900, shortwave_radiation: this.radiation },
                    });
                }
                case "/current_weather": {
                    if (this.weatherServiceDown)
                        return json(503, { detail: "service unavailable" });
                    const slot = Math.floor(Date.now() / 600_000) * 600_000;
                    return json(200, {
                        weather: { timestamp: new Date(slot).toISOString(), solar_10: this.radiation / 6000, solar_30: null, solar_60: null },
                        sources: [],
                    });
                }
                default:
                    return json(404, { error: { code: 21, message: `not found: ${url.pathname}` } });
            }
        });
    }

    private token(request: RecordedRequest, json: (status: number, payload: unknown) => void): void {
        const form = request.form ?? {};
        if (form.client_id !== this.clientId || form.client_secret !== this.clientSecret)
            return json(400, { error: "invalid_client" });
        if (form.grant_type !== "refresh_token" || !form.refresh_token || !this.validRefreshTokens.has(form.refresh_token))
            return json(400, { error: "invalid_grant" });
        // Like Netatmo: new access and refresh token, the previous ones become invalid.
        this.tokenCounter++;
        const accessToken = `access-${this.tokenCounter}`;
        const refreshToken = `refresh-${this.tokenCounter}`;
        this.validRefreshTokens = new Set([refreshToken]);
        this.validAccessTokens = new Set([accessToken]);
        json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: this.tokenLifetime, expire_in: this.tokenLifetime, scope: ["read_station"] });
    }

    /** Webhooks API: GET lists, POST adds one, PUT replaces all, DELETE removes all webhooks of the user. */
    private webhooksApi(request: RecordedRequest, json: (status: number, payload: unknown) => void): void {
        const token = request.authorization?.replace(/^Bearer /, "");
        if (!token || !this.validAccessTokens.has(token))
            return json(401, { error: { code: 3, message: "Access token expired" } });
        if (this.webhooksFailWith !== undefined)
            return json(this.webhooksFailWith, { error: { code: 13, message: "This application is not authorized to use the Webhooks API" } });
        const urls = (value: unknown): string[] | undefined => {
            const entries = Array.isArray(value) ? value : value ? [value] : [];
            const result = entries.map((entry) => (entry as { url?: unknown }).url);
            return result.every((url) => typeof url === "string" && /^https?:\/\//.test(url)) ? result as string[] : undefined;
        };
        switch (request.method) {
            case "GET":
                break;
            case "POST": {
                const added = urls(request.json);
                if (!added || added.length !== 1)
                    return json(400, { error: { code: 21, message: "Invalid request body or URL" } });
                if (!this.webhooks.includes(added[0]))
                    this.webhooks.push(added[0]);
                break;
            }
            case "PUT": {
                const replaced = urls(request.json);
                if (!replaced || !Array.isArray(request.json))
                    return json(400, { error: { code: 21, message: "Invalid request body or URL format" } });
                this.webhooks = [...new Set(replaced)];
                break;
            }
            case "DELETE":
                this.webhooks = [];
                break;
            default:
                return json(405, { error: { code: 21, message: "method not allowed" } });
        }
        json(200, { status: "ok", time_server: Math.round(Date.now() / 1000), body: this.webhooks.map((url) => ({ url })) });
    }

    /**
     * Sends a webhook like Netatmo: POST with the body signed with the client secret. `target`
     * replaces the registered URL (the tests cannot use a public address).
     */
    async sendWebhook(target: string, payload: unknown, options: { secret?: string; signature?: string } = {}): Promise<DeliveredWebhook> {
        const body = JSON.stringify(payload);
        const signature = options.signature ?? webhookSignature(body, options.secret ?? this.clientSecret);
        return new Promise<DeliveredWebhook>((resolve, reject) => {
            const req = http.request(target, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), [SIGNATURE_HEADER]: signature },
                agent: false,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(body);
        });
    }

    /**
     * A device event of a station as the new webhooks send it: the measurements of all modules
     * (names of the webhooks, e.g. "pressure_sea", "gustspeed") with the time they were last seen.
     * The webhooks come right after the measurement (`age`, default 5 s), long before the station
     * data of the cloud has it.
     */
    deviceEvent(station: SimulatedStation = this.stations[0], options: { now?: number; age?: number } = {}): Record<string, unknown> {
        const now = options.now ?? Date.now() / 1000;
        const age = options.age ?? 5;
        const modules: Record<string, unknown>[] = [{
            id: station.id,
            type: "NAMain",
            ...webhookValues(station.values),
            wifi_status: 56,
            firmware: 300,
            last_seen: Math.round(now - age),
        }];
        for (const module of station.modules) {
            modules.push({
                id: module.id,
                type: module.type,
                ...(module.reachable === false ? { reachable: false } : webhookValues(module.values)),
                battery_vp: 5800,
                rf_status: 70,
                last_seen: Math.round(now - (module.reachable === false ? 3_600 : age)),
            });
        }
        this.sequence++;
        return {
            push_type: "device_event",
            user_id: "5c810xxxxxxxxxxxxxxxxxxx",
            device_id: station.id,
            home_id: "5c811xxxxxxxxxxxxxxxxxxx",
            home_name: station.name,
            extra_params: { correlation_id: this.sequence * 7, sequence_id: this.sequence, source: "netcom", modules },
        };
    }

    private sequence = 1000;

    private publicData(query: Record<string, string>, now: number): RawPublicStation[] {
        const latNE = Number(query.lat_ne);
        const lonNE = Number(query.lon_ne);
        const latSW = Number(query.lat_sw);
        const lonSW = Number(query.lon_sw);
        const required = query.required_data;
        return this.publicStations
            .filter((station) => station.location[1] <= latNE && station.location[1] >= latSW
                && station.location[0] <= lonNE && station.location[0] >= lonSW)
            .filter((station) => !required
                || (required === "rain" && station.rainLive !== undefined)
                || (required === "wind" && station.wind !== undefined)
                || (required === "temperature" && station.temperature !== undefined))
            .map((station) => rawPublicStation(station, now));
    }
}

/** Values of /getstationsdata under the names of the webhooks. */
function webhookValues(values: Record<string, number>): Record<string, number> {
    const names: Record<string, string> = {
        Temperature: "temperature", Humidity: "humidity", CO2: "co2", Noise: "noise_current",
        Pressure: "pressure_sea", AbsolutePressure: "pressure_abs", WindStrength: "windspeed", WindAngle: "windangle",
        GustStrength: "gustspeed", GustAngle: "gustangle", Rain: "rain", sum_rain_1: "sum_rain_1", sum_rain_24: "sum_rain_24",
    };
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [names[key] ?? key, value]));
}

export function defaultStation(): SimulatedStation {
    return {
        id: "70:ee:50:00:00:01",
        name: "Zuhause",
        mainName: "Wohnzimmer",
        location: [8.6821, 50.1109],
        values: { Temperature: 21.4, Humidity: 48, CO2: 812, Noise: 38, Pressure: 1016.2, AbsolutePressure: 1003.1 },
        modules: [
            { id: "02:00:00:00:00:01", type: "NAModule1", name: "Garten", battery: 80, values: { Temperature: 12.3, Humidity: 81 } },
            { id: "03:00:00:00:00:01", type: "NAModule4", name: "Schlafzimmer", battery: 70, values: { Temperature: 19.2, Humidity: 55, CO2: 1310 } },
        ],
    };
}

function rawModule(module: SimulatedModule, now: number): RawModule {
    const reachable = module.reachable !== false;
    return {
        _id: module.id,
        type: module.type,
        module_name: module.name,
        reachable,
        battery_percent: module.battery,
        last_seen: Math.round(now - (module.age ?? 60)),
        dashboard_data: reachable ? { time_utc: Math.round(now - (module.age ?? 60)), ...module.values } : undefined,
    };
}

function rawStation(station: SimulatedStation, now: number): RawStation {
    return {
        _id: station.id,
        type: "NAMain",
        station_name: station.name,
        module_name: station.mainName ?? "Indoor",
        reachable: true,
        place: { location: station.location, city: "Frankfurt", timezone: "Europe/Berlin", altitude: 112 },
        dashboard_data: { time_utc: Math.round(now - (station.age ?? 60)), ...station.values },
        modules: station.modules.map((module) => rawModule(module, now)),
    };
}

function rawPublicStation(station: SimulatedPublicStation, now: number): RawPublicStation {
    const time = Math.round(now - (station.age ?? 120));
    const measures: RawPublicStation["measures"] = {};
    if (station.temperature !== undefined)
        measures[`02:${station.id}`] = { res: { [String(time)]: [station.temperature, 70] }, type: ["temperature", "humidity"] };
    if (station.rainLive !== undefined)
        measures[`05:${station.id}`] = { rain_live: station.rainLive, rain_60min: station.rainLive * 3, rain_24h: 4.2, rain_timeutc: time };
    if (station.wind !== undefined) {
        measures[`06:${station.id}`] = {
            wind_strength: station.wind.strength, wind_angle: 200,
            gust_strength: station.wind.gust, gust_angle: 210, wind_timeutc: time,
        };
    }
    return { _id: station.id, place: { location: station.location, timezone: "Europe/Berlin", altitude: 100 }, measures };
}
