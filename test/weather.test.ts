import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlanSettings, planDevices } from "../src/bridge/plan";
import { PublicSnapshot, StationWeather, WeatherSettings, publicKindsNeeded } from "../src/bridge/weather";
import { kmhToMs } from "../src/fah/datapoints";
import { PublicStation } from "../src/netatmo/publicData";
import { ModuleData, StationData } from "../src/netatmo/stations";

const NOW = 1_780_000_000_000;
const LOCATION = { latitude: 50.1109, longitude: 8.6821 };

function module(type: ModuleData["type"], id: string, name: string, values: Partial<ModuleData> = {}): ModuleData {
    return { id, type, name, reachable: true, time: NOW - 60_000, ...values };
}

function station(modules: ModuleData[]): StationData {
    return {
        id: "70:ee:50:00:00:01",
        name: "Zuhause",
        location: LOCATION,
        main: module("NAMain", "70:ee:50:00:00:01", "Wohnzimmer", { temperature: 21, humidity: 45, co2: 800, pressure: 1015 }),
        modules,
    };
}

const outdoor = module("NAModule1", "02:00:00:00:00:01", "Garten", { temperature: 12.3, humidity: 80 });
const wind = module("NAModule2", "06:00:00:00:00:01", "Wind", { windStrength: 18, gustStrength: 36 });
const rain = (mm: number, age = 60_000) => module("NAModule3", "05:00:00:00:00:01", "Regen", { rain: mm, time: NOW - age });

const settings: WeatherSettings = {
    temperatureSource: "auto",
    rainSource: "auto",
    windSource: "auto",
    windValue: "gust",
    rainHoldMs: 20 * 60_000,
    rainMinStations: 2,
};

function publicStation(id: string, distanceKm: number, values: { temperature?: number; rain?: number; wind?: number }): PublicStation {
    return {
        id,
        location: LOCATION,
        distanceKm,
        temperature: values.temperature !== undefined ? { value: values.temperature, time: NOW - 120_000 } : undefined,
        rain: values.rain !== undefined ? { live: values.rain, time: NOW - 120_000 } : undefined,
        wind: values.wind !== undefined ? { strength: values.wind, gust: values.wind * 1.5, time: NOW - 120_000 } : undefined,
    };
}

const publicData: PublicSnapshot = {
    temperature: [publicStation("a", 1, { temperature: 14 }), publicStation("b", 2, { temperature: 15 }), publicStation("c", 3, { temperature: 16 })],
    rain: [publicStation("a", 1, { rain: 0.2 }), publicStation("b", 2, { rain: 0.1 }), publicStation("c", 3, { rain: 0 })],
    wind: [publicStation("a", 1, { wind: 20 })],
};

describe("weather station values", () => {
    it("uses the modules of the own station", () => {
        const result = new StationWeather().compute(station([outdoor, wind, rain(0)]), publicData, settings, NOW);
        assert.deepEqual(result.values, { outdoorTemperature: 12.3, windSpeed: kmhToMs(36), raining: false });
        assert.deepEqual(result.sources, {
            temperature: { kind: "own", module: "Garten" },
            wind: { kind: "own", module: "Wind" },
            rain: { kind: "own", module: "Regen" },
        });
        assert.deepEqual(publicKindsNeeded(station([outdoor, wind, rain(0)]), settings, NOW), []);
        const average = new StationWeather().compute(station([wind]), {}, { ...settings, windValue: "average" }, NOW);
        assert.equal(average.values.windSpeed, kmhToMs(18));
    });

    it("fills in missing modules from the public weather map", () => {
        const own = station([outdoor]);
        assert.deepEqual(publicKindsNeeded(own, settings, NOW), ["rain", "wind"]);
        const result = new StationWeather().compute(own, publicData, settings, NOW);
        assert.deepEqual(result.values, { outdoorTemperature: 12.3, windSpeed: kmhToMs(30), raining: true });
        assert.deepEqual(result.sources.rain, { kind: "public", stations: 3, raining: 2, required: 2 });
        assert.deepEqual(result.sources.wind, { kind: "public", stations: 1 });
    });

    it("falls back to the weather map when an own module has no current values", () => {
        const stale = station([{ ...outdoor, time: NOW - 45 * 60_000 }, { ...wind, reachable: false }]);
        assert.deepEqual(publicKindsNeeded(stale, settings, NOW), ["temperature", "rain", "wind"]);
        const result = new StationWeather().compute(stale, publicData, settings, NOW);
        assert.equal(result.values.outdoorTemperature, 15);
        assert.deepEqual(result.sources.temperature, { kind: "public", stations: 3 });
    });

    it("respects the source settings", () => {
        const own = station([outdoor, wind, rain(0.3)]);
        const onlyPublic: WeatherSettings = { ...settings, temperatureSource: "public", rainSource: "public", windSource: "public" };
        assert.deepEqual(publicKindsNeeded(own, onlyPublic, NOW), ["temperature", "rain", "wind"]);
        assert.equal(new StationWeather().compute(own, publicData, onlyPublic, NOW).values.outdoorTemperature, 15);

        const onlyOwn: WeatherSettings = { ...settings, temperatureSource: "own", rainSource: "own", windSource: "own" };
        const withoutModules = station([]);
        assert.deepEqual(publicKindsNeeded(withoutModules, onlyOwn, NOW), []);
        const result = new StationWeather().compute(withoutModules, publicData, onlyOwn, NOW);
        assert.equal(result.values.outdoorTemperature, undefined);
        assert.equal(result.values.windSpeed, undefined);
        assert.equal(result.values.raining, undefined);
        assert.deepEqual(result.sources, { temperature: { kind: "none" }, wind: { kind: "none" }, rain: { kind: "none" } });

        const off: WeatherSettings = { ...settings, temperatureSource: "off", rainSource: "off", windSource: "off" };
        const nothing = new StationWeather().compute(own, publicData, off, NOW);
        assert.deepEqual(nothing.values, {});
        assert.deepEqual(publicKindsNeeded(own, off, NOW), []);
    });

    it("keeps the rain alarm for the hold time after the last rain", () => {
        const weather = new StationWeather();
        assert.equal(weather.compute(station([rain(0.1, 5 * 60_000)]), {}, settings, NOW).values.raining, true);
        // Dry again: the alarm stays on until 20 minutes after the measurement with rain.
        assert.equal(weather.compute(station([rain(0)]), {}, settings, NOW + 10 * 60_000).values.raining, true);
        assert.equal(weather.compute(station([rain(0)]), {}, settings, NOW + 14 * 60_000).values.raining, true);
        assert.equal(weather.compute(station([rain(0)]), {}, settings, NOW + 16 * 60_000).values.raining, false);

        const noHold = new StationWeather();
        const direct = { ...settings, rainHoldMs: 0 };
        assert.equal(noHold.compute(station([rain(0.1)]), {}, direct, NOW).values.raining, true);
        assert.equal(noHold.compute(station([rain(0)]), {}, direct, NOW + 1).values.raining, false);
    });

    it("keeps a running rain alarm when rain data is missing, but only for the hold time", () => {
        const weather = new StationWeather();
        weather.compute(station([rain(0.5)]), {}, settings, NOW);
        const onlyOwn = { ...settings, rainSource: "own" as const };
        assert.equal(weather.compute(station([]), {}, onlyOwn, NOW + 5 * 60_000).values.raining, true);
        assert.equal(weather.compute(station([]), {}, onlyOwn, NOW + 30 * 60_000).values.raining, undefined);
    });
});

describe("device plan", () => {
    const plan: PlanSettings = { weatherStation: true, indoorSensors: "separate", outdoorHumidity: true, excluded: [], nameLanguage: "de" };
    const indoor = module("NAModule4", "03:00:00:00:00:01", "Schlafzimmer");

    it("creates a weather station and one sensor per indoor value", () => {
        const devices = planDevices([station([outdoor, indoor, wind])], plan);
        assert.deepEqual(devices.map((device) => [device.nativeId, device.name, device.type]), [
            ["netatmo-ws-70ee50000001", "Wetterstation Zuhause", "WeatherStation"],
            ["netatmo-70ee50000001-temperature", "Wohnzimmer Temperatur", "AirQualityTemperature"],
            ["netatmo-70ee50000001-humidity", "Wohnzimmer Luftfeuchte", "AirQualityHumidity"],
            ["netatmo-70ee50000001-co2", "Wohnzimmer CO2", "AirQualityCO2"],
            ["netatmo-70ee50000001-pressure", "Wohnzimmer Luftdruck", "AirQualityPressure"],
            ["netatmo-020000000001-humidity", "Garten Luftfeuchte", "AirQualityHumidity"],
            ["netatmo-030000000001-temperature", "Schlafzimmer Temperatur", "AirQualityTemperature"],
            ["netatmo-030000000001-humidity", "Schlafzimmer Luftfeuchte", "AirQualityHumidity"],
            ["netatmo-030000000001-co2", "Schlafzimmer CO2", "AirQualityCO2"],
        ]);
        for (const device of devices)
            assert.match(device.nativeId, /^[a-zA-Z0-9_-]{1,64}$/);
    });

    it("creates combined sensors, English names and respects exclusions", () => {
        const devices = planDevices([station([outdoor, indoor])], {
            ...plan, indoorSensors: "combined", outdoorHumidity: false, excluded: ["schlafzimmer"], nameLanguage: "en",
        });
        assert.deepEqual(devices.map((device) => [device.name, device.type, device.quantities]), [
            ["Weather station Zuhause", "WeatherStation", []],
            ["Wohnzimmer Indoor climate", "AirQualityFull", ["temperature", "humidity", "co2", "pressure"]],
        ]);
        assert.deepEqual(planDevices([station([outdoor])], { ...plan, weatherStation: false, indoorSensors: "off", excluded: ["02:00:00:00:00:01"] }), []);
        assert.deepEqual(planDevices([station([outdoor])], { ...plan, excluded: ["zuhause"] }), [], "excluding the station name skips the station");
    });
});
