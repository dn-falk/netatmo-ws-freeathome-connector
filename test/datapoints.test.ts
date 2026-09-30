import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ParameterIds, PairingIds } from "@busch-jaeger/free-at-home";

import { OUTPUT_RULES, PairingId, ParameterId, beaufort, kmhToMs } from "../src/fah/datapoints";
import { FahDevice } from "../src/fah/device";
import { Logger } from "../src/log";
import { FakeHandle } from "./support/fakes";

Logger.silent = true;

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("free@home datapoints", () => {
    it("uses the pairing and parameter IDs of the free@home library", () => {
        for (const [name, value] of Object.entries(PairingId))
            assert.equal(value, (PairingIds as unknown as Record<string, number>)[name], name);
        for (const [name, value] of Object.entries(ParameterId))
            assert.equal(value, (ParameterIds as unknown as Record<string, number>)[name], name);
    });

    it("has one rule per output", () => {
        const ids = OUTPUT_RULES.map((rule) => rule.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    it("converts wind speeds to Beaufort", () => {
        assert.equal(beaufort(0), 0);
        assert.equal(beaufort(0.29), 0);
        assert.equal(beaufort(0.3), 1);
        assert.equal(beaufort(5.4), 3);
        assert.equal(beaufort(5.5), 4);
        assert.equal(beaufort(kmhToMs(50)), 6, "13.9 m/s is 50.04 km/h");
        assert.equal(beaufort(kmhToMs(51)), 7);
        assert.equal(beaufort(kmhToMs(118)), 12);
        assert.equal(beaufort(100), 12);
    });
});

describe("FahDevice", () => {
    it("writes the values of a weather station to its channels, each only when changed", async () => {
        const handle = new FakeHandle("WeatherStation");
        const device = new FahDevice("netatmo-ws-1", "Wetterstation", "WeatherStation", handle);

        device.update({ outdoorTemperature: 12.345, windSpeed: 5.56, raining: false, brightness: 23456.4 });
        await tick();
        assert.equal(handle.output(PairingId.AL_OUTDOOR_TEMPERATURE), "12.3");
        assert.equal(handle.output(PairingId.AL_WIND_SPEED), "5.6");
        assert.equal(handle.output(PairingId.AL_WIND_FORCE), "4");
        assert.equal(handle.output(PairingId.AL_RAIN_ALARM), "0");
        assert.equal(handle.output(PairingId.AL_BRIGHTNESS_LEVEL), "23456");
        // No thresholds known yet: no alarms.
        assert.equal(handle.output(PairingId.AL_FROST_ALARM), undefined);
        assert.equal(handle.output(PairingId.AL_WIND_ALARM), undefined);
        assert.equal(handle.output(PairingId.AL_BRIGHTNESS_ALARM), undefined);

        const writes = handle.channels.reduce((sum, channel) => sum + channel.writes.length, 0);
        device.update({ outdoorTemperature: 12.3 });
        await tick();
        assert.equal(handle.channels.reduce((sum, channel) => sum + channel.writes.length, 0), writes, "unchanged values are not written again");
    });

    it("derives the alarms from the thresholds set in free@home", async () => {
        const handle = new FakeHandle("WeatherStation");
        const device = new FahDevice("netatmo-ws-1", "Wetterstation", "WeatherStation", handle);
        device.update({ outdoorTemperature: 2.5, windSpeed: 12, brightness: 30_000, raining: true });

        handle.channelWith(PairingId.AL_FROST_ALARM).setParameter(ParameterId.PID_FROST_ALARM_ACTIVATION_LEVEL, "3");
        handle.channelWith(PairingId.AL_WIND_ALARM).setParameter(ParameterId.PID_WIND_FORCE, "7");
        handle.channelWith(PairingId.AL_BRIGHTNESS_ALARM).setParameter(ParameterId.PID_BRIGHTNESS_ALERT_ACTIVATION_LEVEL, "20000");
        await tick();
        assert.equal(handle.output(PairingId.AL_FROST_ALARM), "1");
        assert.equal(handle.output(PairingId.AL_WIND_ALARM), "0", "12 m/s is Beaufort 6");
        assert.equal(handle.output(PairingId.AL_BRIGHTNESS_ALARM), "1");
        assert.equal(handle.output(PairingId.AL_RAIN_ALARM), "1");

        device.update({ outdoorTemperature: 3.1, windSpeed: 14, brightness: 19_999, raining: false });
        await tick();
        assert.equal(handle.output(PairingId.AL_FROST_ALARM), "0");
        assert.equal(handle.output(PairingId.AL_WIND_ALARM), "1");
        assert.equal(handle.output(PairingId.AL_BRIGHTNESS_ALARM), "0");
        assert.equal(handle.output(PairingId.AL_RAIN_ALARM), "0");
    });

    it("writes only the outputs an air quality sensor has, including alerts", async () => {
        const handle = new FakeHandle("AirQualityFull");
        const device = new FahDevice("netatmo-x-air", "Raumklima", "AirQualityFull", handle);
        const channel = handle.channels[0];
        channel.hasOutput = (id) => id !== PairingId.AL_HUMIDITY_ALERT
            && [PairingId.AL_MEASURED_TEMPERATURE, PairingId.AL_HUMIDITY, PairingId.AL_INFO_CO_2, PairingId.AL_INFO_PRESSURE, PairingId.AL_CO2_ALERT].includes(id as never);
        channel.parameters.set(ParameterId.PID_CO2_ALERT_ACTIVATION_LEVEL, "1000");

        device.update({ temperature: 21.44, humidity: 47.6, co2: 1234, pressure: 1016.24, outdoorTemperature: 5 });
        await tick();
        assert.equal(channel.outputs.get(PairingId.AL_MEASURED_TEMPERATURE), "21.4");
        assert.equal(channel.outputs.get(PairingId.AL_HUMIDITY), "48");
        assert.equal(channel.outputs.get(PairingId.AL_INFO_CO_2), "1234");
        assert.equal(channel.outputs.get(PairingId.AL_INFO_PRESSURE), "101624", "hPa from Netatmo, Pa for free@home");
        assert.equal(channel.outputs.get(PairingId.AL_CO2_ALERT), "1");
        assert.equal(channel.outputs.has(PairingId.AL_OUTDOOR_TEMPERATURE), false);

        channel.setParameter(ParameterId.PID_ENABLE_CO2_ALERT, "0");
        await tick();
        assert.equal(channel.outputs.get(PairingId.AL_CO2_ALERT), "0");
    });

    it("handles reachability and sends all values again when reachable", async () => {
        const handle = new FakeHandle("AirQualityTemperature");
        const device = new FahDevice("netatmo-x-temperature", "Temperatur", "AirQualityTemperature", handle);
        device.update({ temperature: 20 });
        await tick();
        assert.equal(handle.channels[0].writes.length, 1);

        await device.setAvailable(false);
        assert.equal(handle.unresponsiveCalls, 1);
        device.update({ temperature: 21 });
        await device.keepAlive();
        await tick();
        assert.equal(handle.channels[0].writes.length, 1, "nothing is written while unreachable");
        assert.equal(handle.keepAlives, 0);

        await device.setAvailable(true);
        await tick();
        assert.equal(handle.keepAlives, 1);
        assert.deepEqual(handle.channels[0].writes.at(-1), { id: PairingId.AL_MEASURED_TEMPERATURE, value: "21" });

        device.republish();
        await tick();
        assert.equal(handle.channels[0].writes.length, 3, "republish sends the values again");
    });
});
