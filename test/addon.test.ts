import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { parseTokenState } from "../src/config";
import { PairingId, ParameterId } from "../src/fah/datapoints";
import { FakeSysap } from "./support/fakeSysap";
import { waitFor } from "./support/fakes";
import { NetatmoSimulator, defaultStation } from "./support/netatmoSimulator";

// ADDON_ROOT allows running this test against an unpacked addon archive (.tar).
const ROOT = process.env.ADDON_ROOT ?? resolve(__dirname, "..", "..");
const MAIN = process.env.ADDON_ROOT ? join(ROOT, "build", "main.js") : join(ROOT, ".test-build", "src", "main.js");
const ADDON_ID = (JSON.parse(readFileSync(join(ROOT, "free-at-home-metadata.json"), "utf8")) as { id: string }).id;

const WS = "netatmo-ws-70ee50000001";

/**
 * Runs the compiled addon (with the real @busch-jaeger/free-at-home library) as separate
 * process against a fake System Access Point and the simulated Netatmo cloud.
 */
describe("addon process (real free@home library, fake System Access Point)", () => {
    let sysap: FakeSysap;
    let simulator: NetatmoSimulator;
    let baseUrl: string;
    let addon: ChildProcess;
    let output = "";
    let exitCode: number | null | undefined;

    const configuration = (refreshToken: string) => ({
        netatmo: { items: { clientId: simulator.clientId, clientSecret: simulator.clientSecret, refreshToken } },
        devices: { items: { indoorSensors: "separate", outdoorHumidity: true, deviceNameLanguage: "de" } },
        weather: { items: { temperatureSource: "auto", rainSource: "auto", windSource: "auto", brightnessSource: "openmeteo", rainHold: 0 } },
        advanced: { items: { debug: true } },
    });

    function startAddon(): void {
        exitCode = undefined;
        addon = spawn(process.execPath, [MAIN], {
            cwd: ROOT,
            env: {
                ...process.env,
                FREEATHOME_BASE_URL: baseUrl,
                FREEATHOME_API_USERNAME: "installer",
                FREEATHOME_API_PASSWORD: "12345",
                NETATMO_API_URL: simulator.url,
                OPEN_METEO_URL: simulator.url,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        addon.stdout?.on("data", (chunk: Buffer) => output += chunk.toString());
        addon.stderr?.on("data", (chunk: Buffer) => output += chunk.toString());
        addon.on("exit", (code) => exitCode = code);
    }

    async function stopAddon(): Promise<void> {
        addon.kill("SIGTERM");
        await check(() => exitCode !== undefined, "process exit");
    }

    before(async () => {
        simulator = new NetatmoSimulator({
            radiation: 350,
            publicStations: [
                { id: "70:ee:50:aa:00:01", location: [8.69, 50.112], rainLive: 0.3 },
                { id: "70:ee:50:aa:00:02", location: [8.70, 50.115], rainLive: 0.2 },
                { id: "70:ee:50:aa:00:04", location: [8.67, 50.12], wind: { strength: 7.2, gust: 18 } },
            ],
        });
        await simulator.listen();
        sysap = new FakeSysap(ADDON_ID);
        baseUrl = await sysap.listen();
        sysap.setConfiguration(configuration(simulator.initialRefreshToken));
        startAddon();
    });

    after(async () => {
        if (process.env.SHOW_ADDON_OUTPUT)
            console.log(output);
        if (exitCode === undefined)
            addon.kill("SIGKILL");
        await sysap.close();
        await simulator.close();
    });

    const check = async (condition: () => boolean, what: string, timeoutMs = 8_000) => {
        try {
            await waitFor(condition, timeoutMs, what);
        } catch (error) {
            const devices = [...sysap.devices.values()].map((device) => `${device.nativeId}: ttl ${device.ttl}`).join(", ");
            throw new Error(`${(error as Error).message}\n--- devices: ${devices}\n--- addon output ---\n${output}`);
        }
    };

    it("creates a weather station and the indoor sensors", async () => {
        await check(() => sysap.devices.size === 9, "virtual devices");
        assert.equal(sysap.device(WS).type, "WeatherStation");
        assert.equal(sysap.device(WS).displayName, "Wetterstation Zuhause");
        assert.equal(sysap.device("netatmo-70ee50000001-co2").type, "AirQualityCO2");
        assert.equal(sysap.device("netatmo-030000000001-temperature").displayName, "Schlafzimmer Temperatur");

        // The datapoints arrive one after another.
        const expected: [string, number, string][] = [
            [WS, PairingId.AL_OUTDOOR_TEMPERATURE, "12.3"],
            [WS, PairingId.AL_RAIN_ALARM, "1"],
            [WS, PairingId.AL_WIND_SPEED, "5"], // gusts of 18 km/h
            [WS, PairingId.AL_WIND_FORCE, "3"],
            ["netatmo-70ee50000001-co2", PairingId.AL_INFO_CO_2, "812"],
            ["netatmo-70ee50000001-pressure", PairingId.AL_INFO_PRESSURE, "101620"],
            ["netatmo-020000000001-humidity", PairingId.AL_HUMIDITY, "81"],
        ];
        for (const [nativeId, pairingId, value] of expected)
            await check(() => sysap.output(nativeId, pairingId) === value, `${nativeId} 0x${pairingId.toString(16)} = ${value}`);
        await check(() => sysap.output(WS, PairingId.AL_BRIGHTNESS_LEVEL) !== undefined, "brightness");
        await check(() => sysap.applicationStates.some((state) =>
            (state as { state?: { id?: string } }).state?.id === "ok"
            && /Verbunden, 1 Station\(en\), 9 free@home-Geräte/.test((state as { state: { text: string } }).state.text)), "application state");
    });

    it("stores the new refresh token in the addon configuration without restarting", async () => {
        await check(() => sysap.savedConfigurations.length >= 1, "stored configuration");
        const saved = sysap.savedConfigurations[0] as { netatmo: { items: Record<string, unknown> }; advanced: { items: Record<string, unknown> } };
        assert.equal(parseTokenState(saved.netatmo.items.tokenState)?.refreshToken, "refresh-1");
        assert.equal(saved.netatmo.items.refreshToken, "refresh-0", "the entered token stays as it is");
        assert.equal(saved.advanced.items.debug, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(simulator.requestsTo("/oauth2/token").length, 1, "no restart with a new token request");
        assert.equal(sysap.savedConfigurations.length, 1);
    });

    it("applies the frost alarm threshold set in free@home", async () => {
        sysap.setParameter(WS, 2, ParameterId.PID_FROST_ALARM_ACTIVATION_LEVEL, "15");
        await check(() => sysap.output(WS, PairingId.AL_FROST_ALARM) === "1", "frost alarm");
        sysap.setParameter(WS, 2, ParameterId.PID_FROST_ALARM_ACTIVATION_LEVEL, "3");
        await check(() => sysap.output(WS, PairingId.AL_FROST_ALARM) === "0", "no frost alarm");
    });

    it("answers the status RPCs of the addon settings", async () => {
        await check(() => sysap.rpcConnected, "RPC websocket");
        const status = await sysap.rpc("getParameterConfig", { $parameter: "status", $group: "netatmo" }) as Record<string, string>;
        assert.equal(status["name@de"], "Verbunden, 1 Station(en), 9 free@home-Geräte");
        assert.equal(status.type, "text");
        const sources = await sysap.rpc("getParameterConfig", { $parameter: "currentSources", $group: "weather" }) as Record<string, string>;
        assert.match(sources["name@de"], /^Temperatur Außenmodul · Regen Wetterkarte \(2\/2 Messer mit Regen\) · Wind Wetterkarte \(1 Stationen\) · Helligkeit \d+ lx Open-Meteo$/);
    });

    it("reads the station again when the button is pressed", async () => {
        simulator.stations = [{ ...defaultStation(), values: { ...defaultStation().values, CO2: 1500 } }];
        sysap.sendEvent({ eventType: "buttonPressed", parameter: "resync" });
        await check(() => sysap.output("netatmo-70ee50000001-co2", PairingId.AL_INFO_CO_2) === "1500", "new CO2 value");
    });

    it("continues with the stored refresh token after a restart", async () => {
        await stopAddon();
        assert.equal(exitCode, 0);
        assert.equal(sysap.device(WS).ttl, "0", "devices unreachable while the addon is stopped");
        assert.equal(simulator.currentRefreshToken, "refresh-1", "the entered token is no longer valid");

        startAddon();
        await check(() => sysap.device(WS).ttl !== "0", "reachable again");
        await check(() => simulator.requestsTo("/oauth2/token").length === 2, "token renewed");
        assert.equal(simulator.requestsTo("/oauth2/token")[1].form?.refresh_token, "refresh-1");
        await check(() => sysap.savedConfigurations.length === 2, "next token stored");
        const saved = sysap.savedConfigurations[1] as { netatmo: { items: Record<string, unknown> } };
        assert.equal(parseTokenState(saved.netatmo.items.tokenState)?.refreshToken, "refresh-2");
    });

    it("shows a rejected token in the status and shuts down cleanly", async () => {
        simulator.revokeRefreshTokens();
        simulator.expireAccessTokens();
        sysap.setConfiguration(configuration("a-new-token"));
        await check(() => sysap.applicationStates.some((state) =>
            (state as { state?: { id?: string } }).state?.id === "error"), "error state");
        const status = await sysap.rpc("getParameterConfig", { $parameter: "status", $group: "netatmo" }) as Record<string, string>;
        assert.match(status["name@de"], /Netatmo lehnt den Token ab/);
        assert.equal(status.type, "error");

        await stopAddon();
        assert.equal(exitCode, 0);
        assert.equal(sysap.device("netatmo-70ee50000001-co2").ttl, "0");
        assert.doesNotMatch(output, /unhandled rejection/i);
    });
});
