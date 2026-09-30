import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Logger } from "../src/log";
import { NetatmoClient } from "../src/netatmo/client";
import { NetatmoError, apiError, tokenError } from "../src/netatmo/errors";
import {
    boundingBox,
    distanceKm,
    median,
    parsePublicStations,
    publicRain,
    publicTemperature,
    publicWind,
} from "../src/netatmo/publicData";
import { isFresh, parseStations } from "../src/netatmo/stations";
import { TokenManager } from "../src/netatmo/tokenManager";
import { NetatmoSimulator } from "./support/netatmoSimulator";

Logger.silent = true;

const FRANKFURT = { latitude: 50.1109, longitude: 8.6821 };

describe("Netatmo station data", () => {
    it("reads stations and modules from /getstationsdata", () => {
        const stations = parseStations({
            devices: [
                {
                    _id: "70:ee:50:00:00:01", type: "NAMain", station_name: "Home", module_name: "Living room", reachable: true,
                    place: { location: [8.68, 50.11] },
                    dashboard_data: { time_utc: 1_700_000_000, Temperature: 21.5, CO2: 700, Humidity: 45, Noise: 35, Pressure: 1015.2 },
                    modules: [
                        { _id: "02:00:00:00:00:01", type: "NAModule1", module_name: "Garden", reachable: true, battery_percent: 90, dashboard_data: { time_utc: 1_700_000_010, Temperature: -1.2, Humidity: 90 } },
                        { _id: "06:00:00:00:00:01", type: "NAModule2", module_name: "", reachable: false },
                        { _id: "07:00:00:00:00:01", type: "NAPlug" },
                    ],
                },
                { _id: "70:ee:50:00:00:02", type: "NAMain", favorite: true, dashboard_data: { time_utc: 1 } },
                { _id: "70:ee:50:00:00:03", type: "NAModule1" },
            ],
        });
        assert.equal(stations.length, 1);
        const [station] = stations;
        assert.equal(station.name, "Home");
        assert.deepEqual(station.location, { latitude: 50.11, longitude: 8.68 });
        assert.equal(station.main.name, "Living room");
        assert.equal(station.main.co2, 700);
        assert.equal(station.main.pressure, 1015.2);
        assert.equal(station.main.time, 1_700_000_000_000);
        assert.deepEqual(station.modules.map((module) => [module.type, module.name, module.reachable]), [
            ["NAModule1", "Garden", true],
            ["NAModule2", "Wind", false],
        ]);
        assert.equal(station.modules[0].temperature, -1.2);
        assert.equal(station.modules[0].batteryPercent, 90);
    });

    it("treats unreachable modules and old values as not fresh", () => {
        const now = 1_700_000_000_000;
        assert.equal(isFresh({ id: "a", type: "NAModule1", name: "a", reachable: true, time: now - 60_000 }, now), true);
        assert.equal(isFresh({ id: "a", type: "NAModule1", name: "a", reachable: true, time: now - 31 * 60_000 }, now), false);
        assert.equal(isFresh({ id: "a", type: "NAModule1", name: "a", reachable: false, time: now }, now), false);
        assert.equal(isFresh(undefined, now), false);
    });
});

describe("public weather map", () => {
    const now = 1_700_000_000_000;
    const time = now / 1000 - 120;

    it("computes distances and the query area", () => {
        assert.ok(Math.abs(distanceKm(FRANKFURT, { latitude: 50.1109, longitude: 8.7521 }) - 5.0) < 0.1);
        const box = boundingBox(FRANKFURT, 5);
        assert.ok(Math.abs(distanceKm(FRANKFURT, { latitude: box.latNE, longitude: FRANKFURT.longitude }) - 5) < 0.05);
        assert.ok(Math.abs(distanceKm(FRANKFURT, { latitude: FRANKFURT.latitude, longitude: box.lonNE }) - 5) < 0.05);
        const north = boundingBox({ latitude: 84.99, longitude: 10 }, 5);
        assert.equal(north.latNE, 85, "the API accepts latitudes up to 85° only");
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1, 2, 3]), 2.5);
        assert.equal(median([]), undefined);
    });

    it("reads nearby stations, nearest first, without the own station", () => {
        const stations = parsePublicStations([
            {
                _id: "far", place: { location: [8.9, 50.3] },
                measures: { m: { res: { [time]: [10, 80] }, type: ["temperature", "humidity"] } },
            },
            {
                _id: "near", place: { location: [8.69, 50.111] },
                measures: {
                    t: { res: { [time - 600]: [11, 80], [time]: [12, 79] }, type: ["temperature", "humidity"] },
                    r: { rain_live: 0.2, rain_60min: 1.1, rain_24h: 3, rain_timeutc: time },
                    w: { wind_strength: 10, wind_angle: 100, gust_strength: 25, gust_angle: 90, wind_timeutc: time },
                },
            },
            { _id: "own", place: { location: [8.6821, 50.1109] }, measures: {} },
            { _id: "spec", place: { location: [8.683, 50.111] }, measures: { r: { rain_live: 0, rain_utc: time } } },
            { _id: "second", place: { location: [8.70, 50.12] }, measures: { p: { res: { [time]: [1012] }, type: ["pressure"] } } },
            { place: { location: [8.70, 50.12] } },
        ], FRANKFURT, 5, new Set(["own"]));
        assert.deepEqual(stations.map((station) => station.id), ["spec", "near", "second"]);
        assert.deepEqual(stations[0].rain, { live: 0, hour: undefined, time: time * 1000 }, "field name of the specification");
        stations.shift();
        assert.deepEqual(stations[0].temperature, { value: 12, time: time * 1000 });
        assert.deepEqual(stations[0].rain, { live: 0.2, hour: 1.1, time: time * 1000 });
        assert.deepEqual(stations[0].wind, { strength: 10, gust: 25, time: time * 1000 });
        assert.equal(stations[1].temperature, undefined);
    });

    const station = (id: string, distance: number, values: { temperature?: number; rain?: number; wind?: number; age?: number }) => ({
        id,
        location: FRANKFURT,
        distanceKm: distance,
        temperature: values.temperature !== undefined ? { value: values.temperature, time: now - (values.age ?? 0) } : undefined,
        rain: values.rain !== undefined ? { live: values.rain, time: now - (values.age ?? 0) } : undefined,
        wind: values.wind !== undefined ? { strength: values.wind, gust: values.wind * 2, time: now - (values.age ?? 0) } : undefined,
    });

    it("takes the median temperature of the nearest current stations", () => {
        const stations = [
            station("a", 0.5, { temperature: 10 }),
            station("old", 0.6, { temperature: 30, age: 40 * 60_000 }),
            station("b", 1, { temperature: 11 }),
            station("c", 2, { temperature: 25 }),
            station("d", 3, { temperature: 12 }),
            station("e", 4, { temperature: 13 }),
            station("f", 5, { temperature: -20 }),
        ];
        assert.deepEqual(publicTemperature(stations, now), { value: 12, stations: 5, time: now });
        assert.equal(publicTemperature([], now), undefined);
    });

    it("takes the median wind of the three nearest wind gauges", () => {
        const wind = publicWind([station("a", 1, { wind: 10 }), station("b", 2, { wind: 30 }), station("c", 3, { wind: 20 }), station("d", 4, { wind: 90 })], now);
        assert.deepEqual(wind, { strength: 20, gust: 40, stations: 3, time: now });
    });

    it("reports rain only if enough rain gauges measure rain", () => {
        const gauges = [
            station("a", 1, { rain: 0.1 }),
            station("b", 2, { rain: 0 }),
            station("c", 3, { rain: 0 }),
            station("d", 4, { rain: 0.3, age: 5 * 60_000 }),
        ];
        assert.deepEqual(publicRain(gauges, now, 2), { raining: true, rainingStations: 2, stations: 4, required: 2, time: now });
        assert.equal(publicRain(gauges, now, 3)?.raining, false);
        assert.deepEqual(publicRain([station("a", 1, { rain: 0.1 })], now, 2),
            { raining: true, rainingStations: 1, stations: 1, required: 1, time: now }, "fewer stations than required");
        assert.equal(publicRain([station("a", 1, { rain: 0.1, age: 60 * 60_000 })], now, 1), undefined, "old values are ignored");
    });
});

describe("Netatmo errors", () => {
    it("classifies errors of the token endpoint", () => {
        assert.equal(tokenError(400, { error: "invalid_grant" }).kind, "auth");
        assert.equal(tokenError(400, { error: "invalid_client" }).kind, "auth");
        assert.equal(tokenError(503, undefined).kind, "network");
        assert.equal(tokenError(429, {}).kind, "rateLimit");
    });

    it("classifies errors of the data API", () => {
        assert.equal(apiError(403, { error: { code: 3, message: "Access token expired" } }, "/api/x").kind, "token");
        assert.equal(apiError(403, { error: { code: 2, message: "Invalid access token" } }, "/api/x").kind, "token");
        assert.equal(apiError(403, { error: { code: 26, message: "User usage reached" } }, "/api/x").kind, "rateLimit");
        assert.equal(apiError(403, { error: { code: 13, message: "Application does not have the good scope rights" } }, "/api/x").kind, "scope");
        assert.equal(apiError(500, { error: { code: 0, message: "Internal" } }, "/api/x").kind, "network");
        assert.equal(apiError(400, { error: "strange" }, "/api/x").kind, "api");
        assert.match(apiError(403, { error: { code: 3, message: "Access token expired" } }, "/api/x").message, /\/api\/x: HTTP 403 code 3 Access token expired/);
    });
});

describe("NetatmoClient and TokenManager (simulated Netatmo cloud)", () => {
    let simulator: NetatmoSimulator;
    let client: NetatmoClient;

    before(async () => {
        simulator = new NetatmoSimulator({
            publicStations: [
                { id: "70:ee:50:aa:00:01", location: [8.69, 50.11], temperature: 14, rainLive: 0.2 },
                { id: "70:ee:50:aa:00:02", location: [8.70, 50.12], wind: { strength: 12, gust: 30 } },
                { id: "70:ee:50:aa:00:03", location: [9.5, 50.5], rainLive: 1 },
            ],
        });
        client = new NetatmoClient(await simulator.listen());
    });

    after(async () => {
        await simulator.close();
    });

    it("renews tokens, stores every new refresh token and repeats a rejected request once", async () => {
        const stored: string[] = [];
        const tokens = new TokenManager(client, {
            credentials: { clientId: simulator.clientId, clientSecret: simulator.clientSecret },
            refreshToken: simulator.initialRefreshToken,
            onRefreshToken: (token) => stored.push(token),
        });

        const body = await tokens.withAccessToken((token) => client.getStationsData(token));
        assert.equal(parseStations(body).length, 1);
        assert.deepEqual(stored, ["refresh-1"]);
        assert.equal(tokens.currentRefreshToken, simulator.currentRefreshToken);
        const form = simulator.requestsTo("/oauth2/token")[0].form;
        assert.deepEqual(form, { grant_type: "refresh_token", refresh_token: "refresh-0", client_id: "client-id", client_secret: "client-secret" });
        assert.equal(simulator.requestsTo("/api/getstationsdata")[0].authorization, "Bearer access-1");

        await tokens.withAccessToken((token) => client.getStationsData(token));
        assert.equal(simulator.requestsTo("/oauth2/token").length, 1, "the access token is reused");

        simulator.expireAccessTokens();
        await tokens.withAccessToken((token) => client.getStationsData(token));
        assert.equal(simulator.requestsTo("/oauth2/token").length, 2);
        assert.deepEqual(stored, ["refresh-1", "refresh-2"]);
    });

    it("renews only once for parallel requests", async () => {
        const tokens = new TokenManager(client, {
            credentials: { clientId: simulator.clientId, clientSecret: simulator.clientSecret },
            refreshToken: simulator.currentRefreshToken as string,
            onRefreshToken: () => undefined,
        });
        const before = simulator.requestsTo("/oauth2/token").length;
        await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]);
        assert.equal(simulator.requestsTo("/oauth2/token").length, before + 1);
    });

    it("reports a rejected refresh token as authentication error", async () => {
        const tokens = new TokenManager(client, {
            credentials: { clientId: simulator.clientId, clientSecret: simulator.clientSecret },
            refreshToken: "refresh-0",
            onRefreshToken: () => undefined,
        });
        await assert.rejects(tokens.accessToken(), (error: unknown) => error instanceof NetatmoError && error.kind === "auth");
        const wrongSecret = new TokenManager(client, {
            credentials: { clientId: simulator.clientId, clientSecret: "wrong" },
            refreshToken: simulator.currentRefreshToken as string,
            onRefreshToken: () => undefined,
        });
        await assert.rejects(wrongSecret.accessToken(), /invalid_client/);
    });

    it("queries the public weather map with area and data type", async () => {
        const tokens = new TokenManager(client, {
            credentials: { clientId: simulator.clientId, clientSecret: simulator.clientSecret },
            refreshToken: simulator.currentRefreshToken as string,
            onRefreshToken: () => undefined,
        });
        const box = boundingBox(FRANKFURT, 5);
        const rain = await tokens.withAccessToken((token) => client.getPublicData(token, box, "rain"));
        assert.deepEqual(rain.map((station) => station._id), ["70:ee:50:aa:00:01"]);
        const request = simulator.requestsTo("/api/getpublicdata").at(-1);
        assert.equal(request?.query.required_data, "rain");
        assert.equal(request?.query.filter, "true");
        assert.equal(Number(request?.query.lat_ne).toFixed(3), box.latNE.toFixed(3));

        const wind = parsePublicStations(await tokens.withAccessToken((token) => client.getPublicData(token, box, "wind")), FRANKFURT, 5, new Set());
        assert.deepEqual(wind.map((station) => station.wind), [{ strength: 12, gust: 30, time: wind[0].wind?.time }]);
    });

    it("reports network errors", async () => {
        const offline = new NetatmoClient("http://127.0.0.1:1");
        await assert.rejects(offline.getStationsData("x"), (error: unknown) => error instanceof NetatmoError && error.kind === "network");
    });
});
