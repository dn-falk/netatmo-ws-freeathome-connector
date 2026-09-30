import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Bridge, BridgeSettings, BridgeStatus } from "../src/bridge/bridge";
import { PairingId } from "../src/fah/datapoints";
import { Logger } from "../src/log";
import { NetatmoClient } from "../src/netatmo/client";
import { OpenMeteoProvider } from "../src/weather/brightness";
import { FakeRegistry, waitFor } from "./support/fakes";
import { NetatmoSimulator, SimulatedPublicStation, defaultStation } from "./support/netatmoSimulator";

Logger.silent = true;

const PUBLIC_STATIONS: SimulatedPublicStation[] = [
    { id: "70:ee:50:aa:00:01", location: [8.69, 50.112], temperature: 14.1, rainLive: 0.3 },
    { id: "70:ee:50:aa:00:02", location: [8.70, 50.115], temperature: 14.5, rainLive: 0.1 },
    { id: "70:ee:50:aa:00:03", location: [8.66, 50.10], temperature: 13.9, rainLive: 0 },
    { id: "70:ee:50:aa:00:04", location: [8.67, 50.12], wind: { strength: 18, gust: 36 } },
];

const WS = "netatmo-ws-70ee50000001";

function settings(overrides: Partial<BridgeSettings> = {}): BridgeSettings {
    return {
        credentials: { clientId: "client-id", clientSecret: "client-secret" },
        refreshToken: "refresh-0",
        plan: { weatherStation: true, indoorSensors: "separate", outdoorHumidity: true, excluded: [], nameLanguage: "de" },
        weather: { temperatureSource: "auto", rainSource: "auto", windSource: "auto", windValue: "gust", rainHoldMs: 0, rainMinStations: 2 },
        brightnessSource: "openmeteo",
        publicRadiusKm: 5,
        maxPollIntervalMs: 100,
        ...overrides,
    };
}

describe("Bridge (simulated Netatmo cloud)", () => {
    let simulator: NetatmoSimulator | undefined;
    let bridge: Bridge | undefined;

    afterEach(async () => {
        await bridge?.stop();
        bridge = undefined;
        await simulator?.close();
        simulator = undefined;
    });

    async function start(options: { settings?: Partial<BridgeSettings>; registry?: FakeRegistry } = {}) {
        simulator = new NetatmoSimulator({ publicStations: PUBLIC_STATIONS, radiation: 300 });
        const url = await simulator.listen();
        const registry = options.registry ?? new FakeRegistry();
        const tokens: string[] = [];
        const statuses: BridgeStatus[] = [];
        bridge = new Bridge(settings(options.settings), {
            devices: registry,
            onRefreshToken: (token) => tokens.push(token),
            api: new NetatmoClient(url),
            createRadiationProvider: (source) => source === "openmeteo" ? new OpenMeteoProvider(url) : undefined,
            tickIntervalMs: 30,
            retryDelaysMs: [20],
            minPollIntervalMs: 20,
        });
        bridge.on("status", (status) => statuses.push(status));
        bridge.start();
        return { registry, tokens, statuses, simulator };
    }

    it("creates the free@home devices and shows the values of station, weather map and weather service", async () => {
        const { registry, tokens, statuses } = await start();
        await waitFor(() => registry.devices.size === 9 && registry.handles.get(WS)?.output(PairingId.AL_WIND_SPEED) !== undefined, 3_000, "devices and values");
        const ws = registry.handle(WS);
        assert.equal(registry.device(WS).name, "Wetterstation Zuhause");
        assert.equal(ws.output(PairingId.AL_OUTDOOR_TEMPERATURE), "12.3", "own outdoor module");
        assert.equal(ws.output(PairingId.AL_RAIN_ALARM), "1", "2 of 3 public rain gauges measure rain");
        assert.equal(ws.output(PairingId.AL_WIND_SPEED), "10", "gusts of the public wind gauge, 36 km/h");
        assert.equal(ws.output(PairingId.AL_WIND_FORCE), "5");
        assert.ok(Number(ws.output(PairingId.AL_BRIGHTNESS_LEVEL)) >= 0);

        assert.equal(registry.handle("netatmo-70ee50000001-temperature").output(PairingId.AL_MEASURED_TEMPERATURE), "21.4");
        assert.equal(registry.handle("netatmo-70ee50000001-co2").output(PairingId.AL_INFO_CO_2), "812");
        assert.equal(registry.handle("netatmo-70ee50000001-pressure").output(PairingId.AL_INFO_PRESSURE), "101620");
        assert.equal(registry.handle("netatmo-020000000001-humidity").output(PairingId.AL_HUMIDITY), "81");
        assert.equal(registry.handle("netatmo-030000000001-co2").output(PairingId.AL_INFO_CO_2), "1310");

        assert.deepEqual(tokens, ["refresh-1"], "the new refresh token is handed over for storing");
        await waitFor(() => statuses.at(-1)?.state === "online", 1_000, "online status");
        const status = statuses.at(-1) as BridgeStatus;
        assert.equal(status.stations, 1);
        assert.equal(status.devices, 9);
        assert.deepEqual(status.sources[0].temperature, { kind: "own", module: "Garten" });
        assert.deepEqual(status.sources[0].rain, { kind: "public", stations: 3, raining: 2, required: 2 });
        assert.equal(status.sources[0].brightness?.source, "openmeteo");

        const publicRequests = simulator?.requestsTo("/api/getpublicdata") ?? [];
        assert.deepEqual([...new Set(publicRequests.map((request) => request.query.required_data))].sort(), ["rain", "wind"],
            "the weather map is only asked for what the station does not measure");
    });

    it("marks sensors of unreachable modules unreachable and falls back to the weather map", async () => {
        const { registry, simulator: sim } = await start();
        await waitFor(() => registry.handles.get(WS)?.output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3", 3_000, "own temperature");
        sim.stations = [{ ...defaultStation(), modules: defaultStation().modules.map((module) => module.type === "NAModule1" ? { ...module, reachable: false } : module) }];
        await waitFor(() => registry.handle("netatmo-020000000001-humidity").unresponsiveCalls === 1, 3_000, "outdoor humidity unreachable");
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "14.1", 3_000, "median of the public stations");
        assert.equal(registry.device(WS).isAvailable, true);

        sim.stations = [defaultStation()];
        await waitFor(() => registry.handle(WS).output(PairingId.AL_OUTDOOR_TEMPERATURE) === "12.3", 3_000, "own temperature again");
        await waitFor(() => registry.device("netatmo-020000000001-humidity").isAvailable, 3_000, "reachable again");
    });

    it("marks devices of removed modules unreachable", async () => {
        const { registry, simulator: sim } = await start();
        await waitFor(() => registry.devices.size === 9, 3_000, "devices");
        sim.stations = [{ ...defaultStation(), modules: defaultStation().modules.filter((module) => module.type !== "NAModule4") }];
        await waitFor(() => registry.handle("netatmo-030000000001-co2").unresponsiveCalls === 1, 3_000, "removed module unreachable");
        assert.equal(registry.device("netatmo-70ee50000001-co2").isAvailable, true);
    });

    it("reports a rejected refresh token", async () => {
        const { statuses } = await start({ settings: { refreshToken: "revoked" } });
        await waitFor(() => statuses.some((status) => status.state === "offline"), 3_000, "offline");
        const status = statuses.find((entry) => entry.state === "offline") as BridgeStatus;
        assert.match(status.error?.message ?? "", /invalid_grant/);
    });

    it("keeps the devices of earlier settings unreachable and only asks for what is needed", async () => {
        const registry = new FakeRegistry();
        await registry.getOrCreate("netatmo-70ee50000001-temperature", "old", "AirQualityTemperature");
        await start({
            registry,
            settings: {
                plan: { weatherStation: true, indoorSensors: "combined", outdoorHumidity: false, excluded: [], nameLanguage: "en" },
                weather: { temperatureSource: "own", rainSource: "off", windSource: "off", windValue: "average", rainHoldMs: 0, rainMinStations: 1 },
                brightnessSource: "sun",
            },
        });
        await waitFor(() => registry.handles.get("netatmo-70ee50000001-air")?.output(PairingId.AL_INFO_CO_2) === "812", 3_000, "combined sensor");
        const air = registry.handle("netatmo-70ee50000001-air");
        assert.equal(air.output(PairingId.AL_MEASURED_TEMPERATURE), "21.4");
        assert.equal(air.output(PairingId.AL_HUMIDITY), "48");
        assert.equal(air.output(PairingId.AL_INFO_PRESSURE), "101620");
        assert.equal(registry.device("netatmo-030000000001-air").name, "Schlafzimmer Indoor climate");
        await waitFor(() => registry.handle("netatmo-70ee50000001-temperature").unresponsiveCalls === 1, 3_000, "old device unreachable");
        const ws = registry.handle(WS);
        assert.equal(ws.output(PairingId.AL_RAIN_ALARM), undefined);
        assert.equal(ws.output(PairingId.AL_WIND_SPEED), undefined);
        assert.ok(ws.output(PairingId.AL_BRIGHTNESS_LEVEL) !== undefined);
        assert.equal(simulator?.requestsTo("/api/getpublicdata").length, 0);
        assert.equal(simulator?.requestsTo("/v1/forecast").length, 0);
    });
});
