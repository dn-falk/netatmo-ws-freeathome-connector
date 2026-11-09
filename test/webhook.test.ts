import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Bridge, BridgeDependencies, BridgeSettings, BridgeStatus } from "../src/bridge/bridge";
import { LiveData } from "../src/bridge/live";
import { PairingId } from "../src/fah/datapoints";
import { Logger } from "../src/log";
import { NetatmoClient } from "../src/netatmo/client";
import { StationData } from "../src/netatmo/stations";
import { SIGNATURE_HEADER, parseWebhookEvent, verifySignature, webhookSignature } from "../src/netatmo/webhook";
import { AddonStatus, describeWebhook, parameterConfig } from "../src/status";
import { WebhookServer } from "../src/webhookServer";
import { FakeRegistry, delay, waitFor } from "./support/fakes";
import { NetatmoSimulator, SimulatedPublicStation, SimulatedStation, defaultStation } from "./support/netatmoSimulator";

Logger.silent = true;

const WS = "netatmo-ws-70ee50000001";
const OUTDOOR_HUMIDITY = "netatmo-020000000001-humidity";
const URL_A = "https://netatmo.example.com/hook";

/** A webhook of a weather station as captured from the new Netatmo webhooks (shortened). */
const CAPTURED = {
    push_type: "device_event",
    user_id: "5c810xxxxxxxxxxxxxxxxxxx",
    device_id: "70:EE:50:00:00:01",
    home_id: "5c811xxxxxxxxxxxxxxxxxxx",
    home_name: "Météo",
    extra_params: {
        correlation_id: 12345678931,
        sequence_id: 46236611,
        source: "netcom",
        modules: [
            {
                id: "70:ee:50:00:00:01", co2: 714, co2_calibrating: false, firmware: 300, humidity: 51, noise_avg: 40,
                noise_current: 43, pressure_abs: 1011.4, pressure_sea: 1015.3, temperature: 22, trend_pressure: "stable",
                wifi_status: 66, last_seen: 1776433857,
            },
            { id: "02:00:00:00:00:01", temperature: 12.5, humidity: 80, battery_vp: 5960, rf_status: 70, last_message: 1776433800, last_seen: 1776433850 },
            { id: "05:00:00:00:00:01", rain: 0.101, battery_vp: 5800, rf_status: 60 },
            { id: "06:00:00:00:00:01", windangle: 200, windspeed: 12, gustangle: 210, gustspeed: 25, last_seen: 1776433855 },
            { id: "03:00:00:00:00:01", reachable: false, last_seen: 1776400000 },
            { id: "04:00:00:00:00:01", temperature: 999, humidity: "51" },
            { temperature: 20 },
        ],
    },
};

describe("webhook payloads", () => {
    it("checks the signature of the body (HMAC-SHA256 with the client secret)", () => {
        const body = Buffer.from(JSON.stringify(CAPTURED));
        const signature = webhookSignature(body, "secret");
        assert.match(signature, /^[0-9a-f]{64}$/);
        assert.equal(verifySignature(body, "secret", signature), true);
        assert.equal(verifySignature(body, "secret", signature.toUpperCase()), true);
        assert.equal(verifySignature(body, "other secret", signature), false);
        assert.equal(verifySignature(Buffer.from(`${body.toString()} `), "secret", signature), false);
        assert.equal(verifySignature(body, "secret", undefined), false);
        assert.equal(verifySignature(body, "secret", "abc"), false);
    });

    it("reads the measurements of a device event under the names of the webhooks", () => {
        const event = parseWebhookEvent(CAPTURED);
        assert.ok(event);
        assert.equal(event.pushType, "device_event");
        assert.equal(event.deviceId, "70:ee:50:00:00:01");
        assert.deepEqual(event.modules, [
            {
                id: "70:ee:50:00:00:01", time: 1776433857_000, reachable: undefined,
                values: { temperature: 22, humidity: 51, co2: 714, noise: 43, pressure: 1015.3 },
            },
            { id: "02:00:00:00:00:01", time: 1776433850_000, reachable: undefined, values: { temperature: 12.5, humidity: 80 } },
            { id: "05:00:00:00:00:01", time: undefined, reachable: undefined, values: { rain: 0.101 } },
            {
                id: "06:00:00:00:00:01", time: 1776433855_000, reachable: undefined,
                values: { windStrength: 12, gustStrength: 25, windAngle: 200 },
            },
            { id: "03:00:00:00:00:01", time: 1776400000_000, reachable: false, values: {} },
            { id: "04:00:00:00:00:01", time: undefined, reachable: undefined, values: {} },
        ], "implausible values and entries without id are left out");
        assert.equal(parseWebhookEvent({ extra_params: {} }), undefined);
        assert.deepEqual(parseWebhookEvent({ push_type: "topology_changed", extra_params: { change: "home_owner_added" } })?.modules, []);
    });
});

function station(overrides: Partial<StationData["main"]> = {}): StationData {
    return {
        id: "70:ee:50:00:00:01",
        name: "Zuhause",
        main: { id: "70:ee:50:00:00:01", type: "NAMain", name: "Wohnzimmer", reachable: true, time: 1_000_000, temperature: 21, humidity: 50, ...overrides },
        modules: [{ id: "02:00:00:00:00:01", type: "NAModule1", name: "Garten", reachable: true, time: 1_000_000, temperature: 10, humidity: 80 }],
    };
}

describe("LiveData", () => {
    const event = (modules: Record<string, unknown>[], deviceId = "70:ee:50:00:00:01") =>
        parseWebhookEvent({ push_type: "device_event", device_id: deviceId, extra_params: { modules } })!;

    it("lays newer values over the station data and ignores older ones", () => {
        const live = new LiveData();
        const stations = [station()];
        const now = 1_200_000;
        const first = live.apply(event([{ id: "02:00:00:00:00:01", temperature: 11, last_seen: 1_100 }]), stations, now);
        assert.deepEqual(first.updated.map((module) => module.name), ["Garten"]);
        let garden = live.merge(stations)[0].modules[0];
        assert.equal(garden.temperature, 11);
        assert.equal(garden.humidity, 80, "missing fields keep the value of the station data");
        assert.equal(garden.time, 1_100_000);

        // An older webhook delivered late, then one without time and only some values.
        const late = live.apply(event([{ id: "02:00:00:00:00:01", temperature: 9, last_seen: 1_050 }]), stations, now);
        assert.equal(late.outdated, 1);
        live.apply(event([{ id: "02:00:00:00:00:01", humidity: 70 }]), stations, now + 1_000);
        garden = live.merge(stations)[0].modules[0];
        assert.deepEqual([garden.temperature, garden.humidity, garden.time], [11, 70, now + 1_000]);
        assert.equal(live.covered("02:00:00:00:00:01", now + 2_000, 5_000), true);
        assert.equal(live.covered("02:00:00:00:00:01", now + 10_000, 5_000), false);
        assert.equal(live.covered("70:ee:50:00:00:01", now, 5_000), false);
        assert.equal(live.lastEventAt, now + 1_000);

        // The station data catches up: its values count again.
        const newer = [{ ...stations[0], modules: [{ ...stations[0].modules[0], time: now + 60_000, temperature: 12 }] }];
        live.prune(newer, now + 60_000);
        assert.equal(live.merge(newer)[0].modules[0].temperature, 12);
    });

    it("reports unreachable and unknown modules instead of using them", () => {
        const live = new LiveData();
        const stations = [station()];
        const result = live.apply(event([
            { id: "02:00:00:00:00:01", reachable: false, temperature: 3 },
            { id: "03:00:00:00:00:09", temperature: 20 },
            { id: "70:ee:50:00:00:01", wifi_status: 60 },
        ]), stations, 1_200_000);
        assert.deepEqual(result.unreachable.map((module) => module.name), ["Garten"]);
        assert.deepEqual(result.unknown, ["03:00:00:00:00:09"]);
        assert.deepEqual(result.updated, [], "an entry without measurements brings nothing");
        assert.equal(live.merge(stations)[0].modules[0].temperature, 10);
        assert.equal(live.lastEventAt, 1_200_000);
        assert.deepEqual(live.apply(event([{ id: "03:00:00:00:00:09", temperature: 20 }], "70:ee:50:99:99:99"), stations, 1_200_000).unknown, [],
            "modules of other gateways are not ours");
    });
});

function post(port: number, body: string, headers: Record<string, string> = {}, method = "POST"): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/hook", method, headers, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

describe("WebhookServer", () => {
    let server: WebhookServer | undefined;

    afterEach(async () => {
        await server?.stop();
        server = undefined;
    });

    it("accepts only signed POST requests and answers before processing them", async () => {
        const events: unknown[] = [];
        server = new WebhookServer({ port: 0, host: "127.0.0.1", clientSecret: "secret", onEvent: (body) => events.push(body) });
        const port = await server.start();
        const body = JSON.stringify({ push_type: "webhook_activation", user_id: "u" });

        assert.equal((await post(port, body, { [SIGNATURE_HEADER]: webhookSignature(body, "secret") })).status, 200);
        await waitFor(() => events.length === 1, 1_000, "event");
        assert.deepEqual(events[0], { push_type: "webhook_activation", user_id: "u" });

        assert.equal((await post(port, body, { [SIGNATURE_HEADER]: webhookSignature(body, "wrong") })).status, 401);
        assert.equal((await post(port, body)).status, 401);
        assert.equal(server.rejected, 2);
        assert.equal((await post(port, "no json", { [SIGNATURE_HEADER]: webhookSignature("no json", "secret") })).status, 400);
        const large = "x".repeat(300 * 1024);
        assert.equal((await post(port, large, { [SIGNATURE_HEADER]: webhookSignature(large, "secret") })).status, 413);
        const check = await post(port, "", {}, "GET");
        assert.equal(check.status, 200);
        assert.match(check.body, /webhook endpoint/);
        assert.equal((await post(port, "", {}, "PUT")).status, 405);
        await delay(20);
        assert.equal(events.length, 1);
    });

    it("reports a port that cannot be opened", async () => {
        const blocker = http.createServer();
        await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
        try {
            server = new WebhookServer({ port: (blocker.address() as AddressInfo).port, host: "127.0.0.1", clientSecret: "s", onEvent: () => undefined });
            await assert.rejects(server.start(), /EADDRINUSE/);
        } finally {
            await new Promise<void>((resolve) => blocker.close(() => resolve()));
        }
    });
});

const PUBLIC_STATIONS: SimulatedPublicStation[] = [
    { id: "70:ee:50:aa:00:01", location: [8.69, 50.112], temperature: 14.1, rainLive: 0 },
    { id: "70:ee:50:aa:00:04", location: [8.67, 50.12], wind: { strength: 18, gust: 36 } },
];

function settings(overrides: Partial<BridgeSettings> = {}): BridgeSettings {
    return {
        credentials: { clientId: "client-id", clientSecret: "client-secret" },
        refreshToken: "refresh-0",
        plan: { weatherStation: true, indoorSensors: "separate", outdoorHumidity: true, excluded: [], nameLanguage: "de" },
        weather: { temperatureSource: "auto", rainSource: "auto", windSource: "auto", windValue: "gust", rainHoldMs: 0, rainMinStations: 1 },
        brightnessSource: "sun",
        publicRadiusKm: 5,
        maxPollIntervalMs: 100,
        webhook: { url: URL_A, port: 0 },
        ...overrides,
    };
}

describe("Bridge with webhook (simulated Netatmo cloud)", () => {
    let simulator: NetatmoSimulator | undefined;
    let bridge: Bridge | undefined;
    let sender: NodeJS.Timeout | undefined;

    afterEach(async () => {
        clearInterval(sender);
        sender = undefined;
        await bridge?.stop();
        bridge = undefined;
        await simulator?.close();
        simulator = undefined;
    });

    async function start(options: {
        settings?: Partial<BridgeSettings>;
        deps?: Partial<BridgeDependencies>;
        webhooks?: string[];
        webhooksFailWith?: number;
    } = {}) {
        simulator = new NetatmoSimulator({ publicStations: PUBLIC_STATIONS });
        simulator.webhooks = options.webhooks ?? [];
        simulator.webhooksFailWith = options.webhooksFailWith;
        const url = await simulator.listen();
        const registry = new FakeRegistry();
        const registered: (string | undefined)[] = [];
        const statuses: BridgeStatus[] = [];
        const current = new Bridge(settings(options.settings), {
            devices: registry,
            onRefreshToken: () => undefined,
            onWebhookRegistered: (registeredUrl) => registered.push(registeredUrl),
            api: new NetatmoClient(url),
            tickIntervalMs: 30,
            retryDelaysMs: [20],
            minPollIntervalMs: 20,
            webhookCoverageMs: 300,
            webhookPollIntervalMs: 60_000,
            webhookTriggeredPollSpacingMs: 50,
            recheckIntervalMs: 20,
            ...options.deps,
        });
        bridge = current;
        current.on("status", (status) => statuses.push(status));
        current.start();
        const sim = simulator;
        const target = () => `http://127.0.0.1:${current.webhookPort}/hook`;
        const send = (station?: SimulatedStation, secret?: string) => sim.sendWebhook(target(), sim.deviceEvent(station), { secret });
        /** Sends a webhook of the station every 50 ms, as Netatmo would every few minutes. */
        const keepSending = (station: () => SimulatedStation) => {
            sender = setInterval(() => void send(station()).catch(() => undefined), 50);
        };
        const polls = () => sim.requestsTo("/api/getstationsdata").length;
        return { registry, registered, statuses, sim, send, keepSending, polls, bridge: current };
    }

    function withOutdoor(values: Record<string, number>, reachable = true): SimulatedStation {
        const base = defaultStation();
        return { ...base, modules: base.modules.map((module) => module.type === "NAModule1" ? { ...module, reachable, values } : module) };
    }

    it("registers the webhook, shows its values at once and then queries the station data rarely", async () => {
        const { registry, registered, sim, send, keepSending, polls, bridge: current } = await start();
        await waitFor(() => sim.webhooks.length === 1 && registered.length === 1, 3_000, "registration");
        assert.deepEqual(sim.webhooks, [URL_A]);
        assert.deepEqual(registered, [URL_A], "the registered URL is handed over for storing");
        assert.equal(sim.requestsTo("/webhooks/v1/").filter((request) => request.method === "POST").length, 1);
        await waitFor(() => registry.handles.get(WS)?.output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3", 3_000, "values of the query");
        assert.equal(current.status.webhook?.registration, "registered");
        assert.equal(current.status.webhook?.active, false, "no webhook yet");

        // The webhook brings new values before the station data has them (also as a list of events).
        const target = `http://127.0.0.1:${current.webhookPort}/hook`;
        assert.equal((await sim.sendWebhook(target, [{ push_type: "webhook_activation" }, sim.deviceEvent(withOutdoor({ Temperature: 14 }))])).status, 200);
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "14", 1_000, "value of a list of webhooks");
        assert.equal((await send(withOutdoor({ Temperature: 15.5, Humidity: 66 }))).status, 200);
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "15.5", 1_000, "value of the webhook");
        assert.equal(registry.handle(OUTDOOR_HUMIDITY).output(PairingId.AL_HUMIDITY), "66");

        // While webhooks keep coming, the station data is no longer queried every 100 ms.
        keepSending(() => withOutdoor({ Temperature: 15.5, Humidity: 66 }));
        await waitFor(() => current.status.webhook?.active === true, 1_000, "webhook active");
        const before = polls();
        await delay(500);
        assert.ok(polls() <= before + 1, `station data queried ${polls() - before} times while the webhooks covered everything`);
        assert.equal(registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE), "15.5");

        // The webhooks stop: the regular queries take over, the devices stay reachable; once the
        // station data has newer values than the last webhook, those count.
        clearInterval(sender);
        const base = defaultStation();
        sim.stations = [{ ...base, age: 0, modules: base.modules.map((module) => ({ ...module, age: 0 })) }];
        await waitFor(() => polls() >= before + 3, 2_000, "regular queries again");
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3", 2_000, "values of the station data again");
        assert.equal(current.status.webhook?.active, false);
        assert.equal(registry.device(OUTDOOR_HUMIDITY).isAvailable, true);
        assert.equal(registry.handle(OUTDOOR_HUMIDITY).unresponsiveCalls, 0);
    });

    it("reads the station data when a webhook reports a module as not reachable", async () => {
        // Coverage long enough that only the webhook can be the reason for the query.
        const { registry, sim, keepSending, bridge: current } = await start({ deps: { webhookCoverageMs: 10_000 } });
        await waitFor(() => registry.handles.get(OUTDOOR_HUMIDITY)?.output(PairingId.AL_HUMIDITY) === "81", 3_000, "values");
        keepSending(() => sim.stations[0]);
        await waitFor(() => current.status.webhook?.active === true, 1_000, "webhook active");

        // Netatmo loses the outdoor module: the webhook says so, the station data confirms it.
        sim.stations = [withOutdoor({}, false)];
        await waitFor(() => registry.handle(OUTDOOR_HUMIDITY).unresponsiveCalls === 1, 1_000, "outdoor humidity unreachable");
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "14.1", 1_000, "weather map instead");
        assert.equal(current.status.webhook?.active, true, "the remaining modules are still covered");
    });

    it("keeps reading the weather map while the station data is queried rarely", async () => {
        const { registry, sim, keepSending, polls, bridge: current } = await start({ deps: { publicRefreshMs: 100 } });
        await waitFor(() => registry.handles.get(WS)?.output(PairingId.AL_WIND_SPEED) === "10", 3_000, "wind of the weather map");
        keepSending(() => sim.stations[0]);
        await waitFor(() => current.status.webhook?.active === true, 1_000, "webhook active");
        const stationPolls = polls();
        const mapRequests = sim.requestsTo("/api/getpublicdata").length;
        sim.publicStations = [PUBLIC_STATIONS[0], { ...PUBLIC_STATIONS[1], wind: { strength: 10, gust: 54 } }];
        await waitFor(() => registry.handle(WS).output(PairingId.AL_WIND_SPEED) === "15", 1_000, "new wind of the weather map");
        assert.ok(sim.requestsTo("/api/getpublicdata").length > mapRequests);
        assert.ok(polls() <= stationPolls + 1);
    });

    it("rejects webhooks with a wrong signature", async () => {
        const { registry, send, bridge: current } = await start();
        await waitFor(() => registry.handles.get(WS)?.output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3" && current.webhookPort !== undefined, 3_000, "values");
        assert.equal((await send(withOutdoor({ Temperature: 30 }), "wrong secret")).status, 401);
        await delay(50);
        assert.equal(registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE), "12.3");
        assert.equal(current.status.webhook?.rejected, 1);
        assert.equal(current.status.webhook?.lastEventAt, undefined);
    });

    it("replaces the URL it registered before and keeps other webhooks of the app", async () => {
        const other = "https://other.example.com/netatmo";
        const old = "https://old.example.com/hook";
        const { sim, registered } = await start({ webhooks: [other, old], settings: { registeredWebhookUrl: old } });
        await waitFor(() => registered.length === 1, 3_000, "registration");
        assert.deepEqual(sim.webhooks, [other, URL_A]);
        assert.equal(sim.requestsTo("/webhooks/v1/").at(-1)?.method, "PUT");
    });

    it("removes the URL it registered when the webhook is switched off", async () => {
        const other = "https://other.example.com/netatmo";
        const { sim, registered, bridge: current } = await start({ webhooks: [other, URL_A], settings: { webhook: undefined, registeredWebhookUrl: URL_A } });
        await waitFor(() => registered.length === 1, 3_000, "removal");
        assert.deepEqual(registered, [undefined]);
        assert.deepEqual(sim.webhooks, [other]);
        assert.equal(current.status.webhook, undefined);
        assert.equal(current.webhookPort, undefined, "no port opened");
    });

    it("does not touch the webhooks when none is configured or registered", async () => {
        const { sim, registry } = await start({ settings: { webhook: undefined } });
        await waitFor(() => registry.handles.get(WS)?.output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3", 3_000, "values");
        await delay(100);
        assert.equal(sim.requestsTo("/webhooks/v1/").length, 0);
    });

    it("keeps querying when Netatmo does not allow webhooks for the app", async () => {
        const { polls, bridge: current } = await start({ webhooksFailWith: 403 });
        await waitFor(() => current.status.webhook?.registration === "failed", 3_000, "failed registration");
        assert.equal(current.status.webhook?.registrationStatus, 403);
        const before = polls();
        await waitFor(() => polls() >= before + 3, 2_000, "regular queries");
    });
});

describe("webhook status", () => {
    const now = 10_000_000;
    const online = (webhook?: Partial<NonNullable<BridgeStatus["webhook"]>>): AddonStatus => ({
        state: "online", stations: 1, devices: 9, plannedDevices: 9, sources: [], complete: true,
        webhook: webhook ? { url: URL_A, port: 8765, listening: true, registration: "registered", rejected: 0, active: false, ...webhook } : undefined,
    });

    it("describes the state of the webhook in the settings", () => {
        assert.match(describeWebhook(online()).en, /^Off/);
        assert.match(describeWebhook(online()).de, /^Aus/);
        assert.match(describeWebhook({ state: "connecting" }).en, /Waiting/);
        assert.match(describeWebhook(online({ listening: false, listenError: "EACCES" })).de, /Port 8765 konnte nicht geöffnet werden \(EACCES\)/);
        assert.match(describeWebhook(online({ registration: "pending" })).en, /registering/);
        assert.match(describeWebhook(online({ registration: "failed", registrationStatus: 403 })).en, /does not allow webhooks/);
        assert.match(describeWebhook(online({ registration: "failed", registrationError: "HTTP 400" })).de, /nicht angenommen \(HTTP 400\)/);
        assert.match(describeWebhook(online({})).en, /no webhook received yet: does https:\/\/netatmo\.example\.com\/hook lead to port 8765/);
        assert.match(describeWebhook(online({ rejected: 3 })).en, /without a valid signature \(3 rejected\)/);
        assert.equal(describeWebhook(online({ lastEventAt: now - 120_000, active: true }), now).de,
            "Aktiv, letzter Webhook vor 2 min; die Stationsdaten werden nur noch stündlich abgefragt");
        assert.match(describeWebhook(online({ lastEventAt: now - 20_000 }), now).en, /less than a minute ago; it does not bring current values of all modules/);

        assert.equal(parameterConfig(online({ registration: "failed" }), "webhookStatus").type, "error");
        assert.equal(parameterConfig(online({ lastEventAt: now, active: true }), "webhookStatus", now).type, "text");
        assert.equal(parameterConfig(online({}), "webhookStatus").type, "text");
    });
});
