import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PollSchedule, UPLOAD_INTERVAL_MS } from "../src/bridge/schedule";
import { STALE_AFTER_MS } from "../src/netatmo/stations";

const MINUTE = 60_000;
const START = 1_780_000_000_000;

/**
 * Polls a simulated cloud that delivers each measurement (one every 10 minutes) some minutes
 * after it was taken, for 6 hours. Returns, from `fromHour` on, the polls per measurement, the
 * longest wait between the arrival of a measurement and the poll that fetched it, and the oldest
 * measurement held.
 */
function simulate(deliveryDelay: (now: number) => number, fromHour = 1) {
    const schedule = new PollSchedule(MINUTE, 10 * MINUTE);
    const available = (now: number) => Math.floor((now - deliveryDelay(now) - START) / UPLOAD_INTERVAL_MS) * UPLOAD_INTERVAL_MS + START;
    const from = START + fromHour * 60 * MINUTE;
    const end = START + 6 * 60 * MINUTE;
    let now = START + 3.7 * MINUTE + deliveryDelay(START);
    let latest: number | undefined;
    let polls = 0;
    let measurements = 0;
    let latestFetch = 0;
    let oldest = 0;
    while (now < end) {
        const current = available(now);
        if (now >= from) {
            polls++;
            if (latest !== undefined)
                oldest = Math.max(oldest, now - latest);
            if (current !== latest) {
                measurements++;
                latestFetch = Math.max(latestFetch, now - (current + deliveryDelay(now)));
            }
        }
        latest = current;
        now += schedule.next(current, now);
    }
    return { pollsPerMeasurement: polls / measurements, latestFetch, oldest };
}

describe("poll schedule", () => {
    it("asks shortly after the next upload", () => {
        const schedule = new PollSchedule(MINUTE, 10 * MINUTE);
        assert.equal(schedule.next(START - MINUTE, START), 9.5 * MINUTE);
        assert.equal(schedule.next(undefined, START), 10 * MINUTE, "no measurement: maximum interval");
        assert.equal(new PollSchedule(MINUTE, 5 * MINUTE).next(START - MINUTE, START), 5 * MINUTE, "at the latest after the maximum interval");
    });

    for (const delay of [0.2, 3, 20, 35]) {
        it(`learns that Netatmo delivers the measurements ${delay} min late`, () => {
            const result = simulate(() => delay * MINUTE);
            assert.ok(result.pollsPerMeasurement <= 1.5, `${result.pollsPerMeasurement} polls per measurement`);
            assert.ok(result.latestFetch <= 1.5 * MINUTE, `fetched up to ${result.latestFetch / MINUTE} min after the arrival`);
            assert.ok(result.oldest < delay * MINUTE + UPLOAD_INTERVAL_MS + 2 * MINUTE, `values up to ${result.oldest / MINUTE} min old`);
            assert.ok(result.oldest < STALE_AFTER_MS);
        });
    }

    it("notices when Netatmo delivers faster again", () => {
        const result = simulate((now) => now < START + 2 * 60 * MINUTE ? 20 * MINUTE : MINUTE, 4);
        assert.ok(result.pollsPerMeasurement <= 1.5, `${result.pollsPerMeasurement} polls per measurement`);
        assert.ok(result.latestFetch <= 1.5 * MINUTE, `fetched up to ${result.latestFetch / MINUTE} min after the arrival`);
    });

    it("waits the maximum interval while the station sends nothing", () => {
        const schedule = new PollSchedule(MINUTE, 10 * MINUTE);
        const latest = START - 5 * MINUTE;
        assert.equal(schedule.next(latest, START), 5.5 * MINUTE);
        assert.equal(schedule.next(latest, START + 6 * MINUTE), MINUTE, "late: ask every minute");
        assert.equal(schedule.next(latest, START + 19 * MINUTE), MINUTE);
        assert.equal(schedule.next(latest, START + 21 * MINUTE), 10 * MINUTE, "nothing new for 20 minutes");
        assert.equal(new PollSchedule(MINUTE, 10 * MINUTE).next(START - STALE_AFTER_MS - MINUTE, START), 10 * MINUTE,
            "values too old to be shown");
    });
});
