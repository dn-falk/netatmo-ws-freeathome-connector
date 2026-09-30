import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Logger } from "../src/log";
import {
    BrightSkyProvider,
    BrightnessService,
    MAX_SAMPLE_AGE_MS,
    OpenMeteoProvider,
    RadiationProvider,
    RadiationSample,
    estimateIlluminance,
} from "../src/weather/brightness";
import { LUX_PER_WATT, clearSkyIlluminance, clearSkyIrradiance, solarElevation, twilightIlluminance } from "../src/weather/sun";
import { NetatmoSimulator } from "./support/netatmoSimulator";

Logger.silent = true;

const FRANKFURT = { latitude: 50.1109, longitude: 8.6821 };
const SUMMER_NOON = Date.parse("2026-06-21T11:26:00Z");
const WINTER_NOON = Date.parse("2026-12-21T11:22:00Z");

describe("position of the sun", () => {
    it("computes the elevation of the sun", () => {
        assert.ok(Math.abs(solarElevation(SUMMER_NOON, FRANKFURT) - 63.3) < 0.3);
        assert.ok(Math.abs(solarElevation(WINTER_NOON, FRANKFURT) - 16.4) < 0.3);
        assert.ok(solarElevation(Date.parse("2026-06-21T23:26:00Z"), FRANKFURT) < -15);
        // Sunrise in Frankfurt on 21 June is at about 3:15 UTC (sun centre at the horizon ~3:10).
        assert.ok(Math.abs(solarElevation(Date.parse("2026-06-21T03:10:00Z"), FRANKFURT)) < 1.5);
    });

    it("models the irradiance of a cloudless sky and the twilight", () => {
        assert.equal(clearSkyIrradiance(-1), 0);
        assert.ok(Math.abs(clearSkyIrradiance(63.3) - 918) < 5);
        assert.ok(clearSkyIlluminance(SUMMER_NOON, FRANKFURT) > 100_000);
        assert.equal(twilightIlluminance(-13), 0);
        assert.ok(Math.abs(twilightIlluminance(-6) - 3) < 0.01);
        assert.ok(Math.abs(twilightIlluminance(0) - 400) < 0.01);
        assert.ok(twilightIlluminance(-3) > 3 && twilightIlluminance(-3) < 400);
        assert.equal(twilightIlluminance(30), 2000);
    });
});

describe("illuminance estimate", () => {
    it("assumes a cloudless sky without measurement", () => {
        const lux = estimateIlluminance(SUMMER_NOON, FRANKFURT);
        assert.ok(Math.abs(lux - clearSkyIrradiance(solarElevation(SUMMER_NOON, FRANKFURT)) * LUX_PER_WATT) < 1);
    });

    it("applies the cloudiness of the last sample to the position of the sun now", () => {
        const sampleTime = SUMMER_NOON - 3 * 3600_000;
        const clear = clearSkyIrradiance(solarElevation(sampleTime, FRANKFURT));
        const sample: RadiationSample = { irradiance: clear * 0.25, time: sampleTime, source: "openmeteo" };
        const lux = estimateIlluminance(SUMMER_NOON, FRANKFURT, sample);
        assert.ok(Math.abs(lux - 0.25 * clearSkyIlluminance(SUMMER_NOON, FRANKFURT)) < 10);
    });

    it("uses twilight values below the horizon", () => {
        const night = Date.parse("2026-06-21T23:26:00Z");
        assert.equal(estimateIlluminance(night, FRANKFURT, { irradiance: 500, time: night, source: "openmeteo" }), 0);
    });

    it("uses the sample directly while the sun is very low", () => {
        const dawn = Date.parse("2026-06-21T03:40:00Z");
        const lux = estimateIlluminance(dawn, FRANKFURT, { irradiance: 20, time: dawn - 450_000, source: "openmeteo" });
        assert.ok(lux >= 20 * LUX_PER_WATT);
    });
});

class FakeProvider implements RadiationProvider {
    readonly name = "openmeteo";
    readonly refreshIntervalMs = 15 * 60_000;
    calls = 0;
    fail = false;

    constructor(private readonly irradiance: number) {}

    async fetch(): Promise<RadiationSample> {
        this.calls++;
        if (this.fail)
            throw new Error("down");
        return { irradiance: this.irradiance, time: SUMMER_NOON - 7.5 * 60_000, source: "openmeteo" };
    }
}

describe("BrightnessService", () => {
    it("fetches when due and falls back to the cloudless sky without current values", async () => {
        const provider = new FakeProvider(200);
        const service = new BrightnessService(provider);
        let now = SUMMER_NOON;
        await service.update(now, FRANKFURT);
        await service.update(now, FRANKFURT);
        assert.equal(provider.calls, 1, "not due again yet");
        const state = service.current(now, FRANKFURT);
        assert.equal(state.source, "openmeteo");
        assert.equal(state.fallback, false);
        assert.ok(state.lux < clearSkyIlluminance(now, FRANKFURT) / 3);

        provider.fail = true;
        now += 20 * 60_000;
        await service.update(now, FRANKFURT);
        assert.equal(provider.calls, 2);
        assert.equal(service.error, "down");
        assert.equal(service.current(now, FRANKFURT).source, "openmeteo", "the last sample is still used");
        await service.update(now + 10_000, FRANKFURT);
        assert.equal(provider.calls, 2, "waits before retrying");

        now = SUMMER_NOON + MAX_SAMPLE_AGE_MS;
        const fallback = service.current(now, FRANKFURT);
        assert.equal(fallback.source, "sun");
        assert.equal(fallback.fallback, true);
        assert.equal(fallback.lux, Math.round(clearSkyIlluminance(now, FRANKFURT)));
    });

    it("only calculates without a weather service", () => {
        const state = new BrightnessService(undefined).current(SUMMER_NOON, FRANKFURT);
        assert.deepEqual(state, { lux: Math.round(clearSkyIlluminance(SUMMER_NOON, FRANKFURT)), source: "sun", fallback: false });
    });
});

describe("weather services (simulated)", () => {
    let simulator: NetatmoSimulator;
    let url: string;

    before(async () => {
        simulator = new NetatmoSimulator({ radiation: 480 });
        url = await simulator.listen();
    });

    after(async () => {
        await simulator.close();
    });

    it("reads the solar radiation from Open-Meteo", async () => {
        const sample = await new OpenMeteoProvider(url).fetch(FRANKFURT);
        assert.equal(sample.irradiance, 480);
        assert.equal(sample.source, "openmeteo");
        const request = simulator.requestsTo("/v1/forecast")[0];
        assert.deepEqual(request.query, { latitude: "50.1109", longitude: "8.6821", current: "shortwave_radiation", timeformat: "unixtime" });
        assert.equal(sample.time % 450_000, 0, "middle of the 15-minute period");
    });

    it("reads the solar radiation from Bright Sky", async () => {
        const sample = await new BrightSkyProvider(url).fetch(FRANKFURT);
        assert.ok(Math.abs(sample.irradiance - 480) < 1e-9);
        assert.equal(sample.source, "brightsky");
        assert.deepEqual(simulator.requestsTo("/current_weather")[0].query, { lat: "50.1109", lon: "8.6821" });
    });

    it("reports errors of the services", async () => {
        simulator.weatherServiceDown = true;
        await assert.rejects(new OpenMeteoProvider(url).fetch(FRANKFURT), /HTTP 503: service unavailable/);
        await assert.rejects(new BrightSkyProvider(url).fetch(FRANKFURT), /HTTP 503/);
        simulator.weatherServiceDown = false;
    });
});
