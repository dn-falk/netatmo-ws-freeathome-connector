import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { App } from "../src/app";
import { Bridge, BridgeSettings } from "../src/bridge/bridge";
import { parseTokenState, tokenFingerprint } from "../src/config";
import { PairingId } from "../src/fah/datapoints";
import { FahDeviceRegistry } from "../src/fah/registry";
import { Logger } from "../src/log";
import { NetatmoClient } from "../src/netatmo/client";
import { AddonStatus, applicationState, describeSources, describeStatus, fromBridgeStatus, parameterConfig } from "../src/status";
import { NetatmoError } from "../src/netatmo/errors";
import { FakeHandle, FakeRegistry, waitFor } from "./support/fakes";
import { NetatmoSimulator } from "./support/netatmoSimulator";

Logger.silent = true;

function configuration(netatmo: Record<string, unknown>) {
    return {
        netatmo: { items: netatmo },
        devices: { items: {} },
        weather: { items: { brightnessSource: "sun", rainSource: "own", windSource: "own" } },
        advanced: { items: { pollInterval: 2 } },
    };
}

const storedToken = (config: Record<string, unknown>) =>
    parseTokenState((config.netatmo as { items: Record<string, unknown> }).items.tokenState);

describe("App", () => {
    let simulator: NetatmoSimulator | undefined;
    let app: App | undefined;

    afterEach(async () => {
        await app?.shutdown();
        app = undefined;
        await simulator?.close();
        simulator = undefined;
    });

    async function setup() {
        simulator = new NetatmoSimulator();
        const url = await simulator.listen();
        const registry = new FakeRegistry();
        const statuses: AddonStatus[] = [];
        const saved: Record<string, unknown>[] = [];
        const bridges: BridgeSettings[] = [];
        app = new App({
            registry,
            publishStatus: (status) => statuses.push(status),
            saveConfiguration: async (config) => {
                saved.push(config);
            },
            createBridge: (settings, deps) => {
                bridges.push(settings);
                return new Bridge(settings, { ...deps, api: new NetatmoClient(url), tickIntervalMs: 30, retryDelaysMs: [20] });
            },
        });
        return { registry, statuses, saved, bridges, simulator };
    }

    it("asks for configuration and marks existing devices unreachable", async () => {
        const { registry } = await setup();
        await registry.getOrCreate("netatmo-x-temperature", "A", "AirQualityTemperature");
        await app?.applyConfiguration("");
        assert.equal(app?.getStatus().state, "configurationNeeded");
        assert.equal(registry.handle("netatmo-x-temperature").unresponsiveCalls, 1);
    });

    it("stores every new refresh token and continues with it after a restart", async () => {
        const { registry, saved, bridges, simulator: sim } = await setup();
        const config = configuration({ clientId: sim.clientId, clientSecret: sim.clientSecret, refreshToken: sim.initialRefreshToken });
        await app?.applyConfiguration(config);
        await waitFor(() => saved.length === 1, 3_000, "stored token");
        assert.deepEqual(storedToken(saved[0]), { origin: tokenFingerprint("refresh-0"), refreshToken: "refresh-1" });
        assert.equal((saved[0].advanced as { items: Record<string, unknown> }).items.pollInterval, 2, "other settings are kept");
        await waitFor(() => app?.getStatus().state === "online", 3_000, "online");
        await waitFor(() => registry.handles.get("netatmo-70ee50000001-co2")?.output(PairingId.AL_INFO_CO_2) === "812", 3_000, "values");

        // The System Access Point sends the stored configuration back: no restart.
        await app?.applyConfiguration(saved[0]);
        assert.equal(bridges.length, 1);
        assert.equal(saved.length, 1, "nothing to store");

        // The app saves the settings with the token state it loaded earlier: the current one is stored again.
        await app?.applyConfiguration(config);
        assert.equal(bridges.length, 1);
        await waitFor(() => saved.length === 2, 3_000, "stored again");
        assert.equal(storedToken(saved[1])?.refreshToken, "refresh-1");

        // Another setting changed while the app still had the old token state: the connection is
        // restarted with the newest token, not with the one in the configuration.
        await app?.applyConfiguration({ ...config, advanced: { items: { pollInterval: 3 } } });
        assert.equal(bridges.length, 2);
        assert.equal(bridges[1].refreshToken, "refresh-1");
        await waitFor(() => app?.getStatus().state === "online", 3_000, "online with the newest token");
        await waitFor(() => storedToken(saved.at(-1) as Record<string, unknown>)?.refreshToken === "refresh-2", 3_000, "renewed again");

        // Restart of the addon with the stored configuration: the stored token is used.
        await app?.shutdown();
        const restarted = await setupAgain(sim);
        await restarted.app.applyConfiguration(saved.at(-1));
        await waitFor(() => restarted.app.getStatus().state === "online", 3_000, "online after restart");
        await waitFor(() => restarted.saved.length === 1, 3_000, "next token stored");
        assert.equal(sim.requestsTo("/oauth2/token").at(-1)?.form?.refresh_token, "refresh-2");
        assert.equal(storedToken(restarted.saved[0])?.refreshToken, "refresh-3");
        await restarted.app.shutdown();
    });

    async function setupAgain(sim: NetatmoSimulator) {
        const saved: Record<string, unknown>[] = [];
        const restartedApp = new App({
            registry: new FakeRegistry(),
            publishStatus: () => undefined,
            saveConfiguration: async (config) => {
                saved.push(config);
            },
            createBridge: (settings, deps) => new Bridge(settings, { ...deps, api: new NetatmoClient(sim.url), tickIntervalMs: 30 }),
        });
        return { app: restartedApp, saved };
    }

    it("restarts with a newly entered refresh token and reports a rejected one", async () => {
        const { bridges, statuses, simulator: sim } = await setup();
        await app?.applyConfiguration(configuration({ clientId: sim.clientId, clientSecret: sim.clientSecret, refreshToken: "refresh-0" }));
        await waitFor(() => app?.getStatus().state === "online", 3_000, "online");
        await app?.applyConfiguration(configuration({ clientId: sim.clientId, clientSecret: sim.clientSecret, refreshToken: "wrong" }));
        assert.equal(bridges.length, 2);
        assert.equal(bridges[1].refreshToken, "wrong");
        await waitFor(() => app?.getStatus().state === "offline", 3_000, "offline");
        const status = app?.getStatus() as AddonStatus;
        assert.ok(status.state === "offline" && status.reason === "auth");
        assert.match(describeStatus(status).de, /bitte einen neuen Refresh Token erzeugen/);
        assert.ok(statuses.some((entry) => entry.state === "connecting"));
    });
});

describe("FahDeviceRegistry", () => {
    it("creates each device once and allows a new attempt after a failure", async () => {
        const handles: FakeHandle[] = [];
        let failNext = true;
        const registry = new FahDeviceRegistry({
            createDevice: async (_nativeId, _name, type) => {
                if (failNext) {
                    failNext = false;
                    throw new Error("SysAP busy");
                }
                const handle = new FakeHandle(type);
                handles.push(handle);
                return handle;
            },
        });
        await assert.rejects(registry.getOrCreate("netatmo-x-co2", "CO2", "AirQualityCO2"), /SysAP busy/);
        const device = await registry.getOrCreate("netatmo-x-co2", "CO2", "AirQualityCO2");
        assert.equal(await registry.getOrCreate("netatmo-x-co2", "CO2", "AirQualityCO2"), device);
        assert.equal(handles.length, 1);

        await registry.keepAliveAll();
        assert.equal(handles[0].keepAlives, 1);
        await registry.setAllAvailable(false);
        assert.equal(handles[0].unresponsiveCalls, 1);
        await registry.keepAliveAll();
        assert.equal(handles[0].keepAlives, 1, "no keep-alive while unreachable");
        await registry.setAllAvailable(true);
        assert.equal(handles[0].keepAlives, 2);
    });
});

describe("status", () => {
    const sources = [{
        station: "Zuhause",
        temperature: { kind: "own" as const, module: "Garten" },
        rain: { kind: "public" as const, stations: 5, raining: 1, required: 2 },
        wind: { kind: "none" as const },
        brightness: { lux: 12345, source: "openmeteo" as const, fallback: false },
    }];

    it("describes the states in German and English", () => {
        const online: AddonStatus = { state: "online", stations: 1, devices: 9, sources };
        assert.equal(describeStatus(online).de, "Verbunden, 1 Station(en), 9 free@home-Geräte");
        assert.match(describeStatus({ state: "online", stations: 0, devices: 0, sources: [] }).en, /no weather station/);
        assert.match(describeStatus({ state: "offline", error: "timeout", reason: "other", sources: [] }).de, /Netatmo nicht erreichbar/);
        assert.match(describeStatus({ state: "offline", error: "x", reason: "scope", sources: [] }).de, /read_station/);
        assert.match(describeStatus({ state: "offline", error: "x", reason: "rateLimit", sources: [] }).en, /Too many requests/);
        assert.match(describeStatus({ state: "offline", error: "x", reason: "appDeactivated", sources: [] }).de, /Netatmo-App wurde deaktiviert/);
        assert.match(describeStatus({ state: "configurationNeeded", problems: [{ en: "client ID is missing", de: "Client ID fehlt" }] }).de,
            /Konfiguration nötig: Client ID fehlt/);
        assert.equal(describeSources(online).de,
            "Temperatur Außenmodul · Regen Wetterkarte (1/5 Messer mit Regen) · Wind keine Daten · Helligkeit 12345 lx Open-Meteo");
        assert.equal(describeSources({ state: "connecting" }).de, "Noch keine Daten der Wetterstation");
        assert.match(describeSources({ ...online, sources: [{ ...sources[0], brightness: { lux: 5, source: "sun", fallback: true } }] }).en,
            /brightness 5 lx calculated \(weather service not available\)/);
    });

    it("maps the bridge status", () => {
        assert.deepEqual(fromBridgeStatus({ state: "online", stations: 1, devices: 2, sources: [] }),
            { state: "online", stations: 1, devices: 2, sources: [] });
        assert.deepEqual(fromBridgeStatus({ state: "offline", stations: 1, devices: 2, sources: [], error: new NetatmoError("token request failed", "auth") }),
            { state: "offline", error: "token request failed", reason: "auth", sources: [] });
        assert.deepEqual(fromBridgeStatus({ state: "connecting", stations: 0, devices: 0, sources: [] }), { state: "connecting" });
    });

    it("builds the parameters of the settings and the application state", () => {
        const offline: AddonStatus = { state: "offline", error: "timeout", reason: "other", sources };
        assert.equal(parameterConfig(offline, "status").type, "error");
        assert.equal(parameterConfig(offline, "currentSources").type, "text");
        assert.match(parameterConfig(offline, "currentSources")["name@de"] as string, /^Temperatur Außenmodul/);
        assert.equal(parameterConfig({ state: "starting" }).type, "text");
        assert.deepEqual(applicationState({ state: "configurationNeeded", problems: [] }),
            { state: { id: "configurationNeeded", text: "Konfiguration nötig: Einstellungen fehlen" } });
        assert.equal((applicationState(offline).state as { id: string }).id, "error");
    });
});
