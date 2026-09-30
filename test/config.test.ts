import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    parseConfiguration,
    parseTokenState,
    restartKey,
    tokenFingerprint,
    withTokenState,
} from "../src/config";

function configuration(netatmo: Record<string, unknown>, others: Record<string, Record<string, unknown>> = {}) {
    return {
        netatmo: { items: netatmo },
        devices: { items: others.devices ?? {} },
        weather: { items: others.weather ?? {} },
        advanced: { items: others.advanced ?? {} },
    };
}

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "token-a" };

describe("configuration", () => {
    it("reports missing settings", () => {
        for (const input of [undefined, "", {}, configuration({})]) {
            const result = parseConfiguration(input);
            assert.equal(result.ok, false);
            if (!result.ok)
                assert.deepEqual(result.problems.map((problem) => problem.de), ["Client ID fehlt", "Client Secret fehlt", "Refresh Token fehlt"]);
        }
    });

    it("applies defaults", () => {
        const result = parseConfiguration(configuration({ clientId: " id ", clientSecret: "secret", refreshToken: "token-a" }));
        assert.ok(result.ok);
        assert.deepEqual(result.settings, {
            clientId: "id",
            clientSecret: "secret",
            refreshToken: "token-a",
            tokenOrigin: tokenFingerprint("token-a"),
            indoorSensors: "separate",
            outdoorHumidity: true,
            excluded: [],
            nameLanguage: "de",
            temperatureSource: "auto",
            rainSource: "auto",
            windSource: "auto",
            brightnessSource: "openmeteo",
            windValue: "gust",
            rainHoldMs: 20 * 60_000,
            publicRadiusKm: 5,
            rainMinStations: 2,
            location: undefined,
            maxPollIntervalMs: 10 * 60_000,
            debug: false,
        });
    });

    it("reads all settings and clamps numbers", () => {
        const result = parseConfiguration(configuration(credentials, {
            devices: { indoorSensors: "combined", outdoorHumidity: false, excludedModules: "Keller,  Garten ", deviceNameLanguage: "en" },
            weather: {
                temperatureSource: "public", rainSource: "own", windSource: "off", brightnessSource: "brightsky", windValue: "average",
                rainHold: "0", publicRadius: 100, rainMinStations: 0, latitude: "50,1109", longitude: "8.6821",
            },
            advanced: { pollInterval: 1, debug: "true" },
        }));
        assert.ok(result.ok);
        const settings = result.settings;
        assert.equal(settings.indoorSensors, "combined");
        assert.equal(settings.outdoorHumidity, false);
        assert.deepEqual(settings.excluded, ["keller", "garten"]);
        assert.equal(settings.nameLanguage, "en");
        assert.equal(settings.temperatureSource, "public");
        assert.equal(settings.rainSource, "own");
        assert.equal(settings.windSource, "off");
        assert.equal(settings.brightnessSource, "brightsky");
        assert.equal(settings.windValue, "average");
        assert.equal(settings.rainHoldMs, 0);
        assert.equal(settings.publicRadiusKm, 25);
        assert.equal(settings.rainMinStations, 1);
        assert.deepEqual(settings.location, { latitude: 50.1109, longitude: 8.6821 });
        assert.equal(settings.maxPollIntervalMs, 2 * 60_000);
        assert.equal(settings.debug, true);
    });

    it("falls back to defaults for unknown options", () => {
        const result = parseConfiguration(configuration(credentials, {
            devices: { indoorSensors: "many" }, weather: { rainSource: "radar", brightnessSource: "moon" },
        }));
        assert.ok(result.ok);
        assert.equal(result.settings.indoorSensors, "separate");
        assert.equal(result.settings.rainSource, "auto");
        assert.equal(result.settings.brightnessSource, "openmeteo");
    });

    it("rejects invalid or incomplete coordinates", () => {
        const invalid = parseConfiguration(configuration(credentials, { weather: { latitude: "95", longitude: "east" } }));
        assert.equal(invalid.ok, false);
        if (!invalid.ok)
            assert.equal(invalid.problems.length, 2);
        const incomplete = parseConfiguration(configuration(credentials, { weather: { latitude: "50.1" } }));
        assert.equal(incomplete.ok, false);
    });

    it("uses the stored refresh token only if it belongs to the entered one", () => {
        const stored = JSON.stringify({ origin: tokenFingerprint("token-a"), refreshToken: "token-a-3" });
        const result = parseConfiguration(configuration({ ...credentials, tokenState: stored }));
        assert.ok(result.ok);
        assert.equal(result.settings.refreshToken, "token-a-3");

        const newToken = parseConfiguration(configuration({ ...credentials, refreshToken: "token-b", tokenState: stored }));
        assert.ok(newToken.ok);
        assert.equal(newToken.settings.refreshToken, "token-b", "a newly entered token wins");

        const damaged = parseConfiguration(configuration({ ...credentials, tokenState: "{no json" }));
        assert.ok(damaged.ok);
        assert.equal(damaged.settings.refreshToken, "token-a");
        assert.equal(parseTokenState(JSON.stringify({ origin: "x" })), undefined);
    });

    it("does not restart for a stored token, but for a newly entered one", () => {
        const plain = parseConfiguration(configuration(credentials));
        const stored = parseConfiguration(configuration({
            ...credentials, tokenState: JSON.stringify({ origin: tokenFingerprint("token-a"), refreshToken: "token-a-9" }),
        }));
        const other = parseConfiguration(configuration({ ...credentials, refreshToken: "token-b" }));
        assert.equal(restartKey(plain), restartKey(stored));
        assert.notEqual(restartKey(plain), restartKey(other));
    });

    it("writes the token state into a copy of the configuration", () => {
        const original = configuration(credentials, { advanced: { debug: true } });
        const copy = withTokenState(original, { origin: "abc", refreshToken: "r2" });
        assert.equal((original.netatmo.items as Record<string, unknown>).tokenState, undefined);
        assert.deepEqual(parseTokenState((copy.netatmo as { items: Record<string, unknown> }).items.tokenState), { origin: "abc", refreshToken: "r2" });
        assert.deepEqual(copy.advanced, { items: { debug: true } });
        assert.deepEqual(withTokenState(undefined, { origin: "o", refreshToken: "r" }), {
            netatmo: { items: { tokenState: JSON.stringify({ origin: "o", refreshToken: "r" }) } },
        });
    });
});
