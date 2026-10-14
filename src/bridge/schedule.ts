import { STALE_AFTER_MS } from "../netatmo/stations";

/** The station sends its values to the cloud every 10 minutes. */
export const UPLOAD_INTERVAL_MS = 10 * 60_000;
/** Wait after the expected upload before asking (the cloud needs a moment). */
const UPLOAD_DELAY_MS = 30_000;

/**
 * Decides when to fetch the station data again: shortly after the next measurement is available.
 *
 * Netatmo usually delivers a measurement within a minute, but at times only 20 minutes or more
 * after it was taken. The delay is learned from the polls: when a poll shortly after the previous
 * one returns a new measurement, it arrived in between. Otherwise the next poll is planned a
 * little earlier, so a shorter delay is noticed again.
 */
export class PollSchedule {
    private latest: number | undefined;
    private latestSeenAt = 0;
    private lastPollAt: number | undefined;
    private delayMs = 0;

    constructor(private readonly minimumMs: number, private readonly maximumMs: number) {}

    /** How long after it was taken a measurement becomes available (learned). */
    get deliveryDelayMs(): number {
        return this.delayMs;
    }

    /** Records a poll at `now` that returned measurements up to `latest`; returns the wait until the next poll. */
    next(latest: number | undefined, now: number): number {
        const previousPoll = this.lastPollAt;
        this.lastPollAt = now;
        const maximum = Math.max(this.minimumMs, this.maximumMs);
        if (latest === undefined)
            return maximum;
        if (latest !== this.latest) {
            // It is here now, so the delay is at most this long.
            const delay = Math.max(0, now - latest);
            if (this.latest !== undefined && previousPoll !== undefined) {
                this.delayMs = now - previousPoll <= 2 * this.minimumMs
                    ? delay
                    : Math.max(0, Math.min(this.delayMs, delay) - this.minimumMs);
            }
            this.latest = latest;
            this.latestSeenAt = now;
        }
        if (now - latest > STALE_AFTER_MS || now - this.latestSeenAt > 2 * UPLOAD_INTERVAL_MS)
            return maximum; // station offline, no upload expected soon
        const expected = latest + UPLOAD_INTERVAL_MS + this.delayMs + UPLOAD_DELAY_MS;
        return Math.min(maximum, Math.max(this.minimumMs, expected - now));
    }
}
