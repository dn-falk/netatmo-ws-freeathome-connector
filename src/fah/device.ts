import { Logger, errorMessage } from "../log";
import { OUTPUT_RULES, SensorValues } from "./datapoints";

/** One channel of a virtual free@home device (allows fakes in tests). */
export interface ChannelLike {
    /** Parameters set in the free@home app (e.g. alarm thresholds), and their changes. */
    readonly parameters: ReadonlyMap<number, string>;
    onParameterChanged(listener: (id: number, value: string) => void): void;
    hasOutput(id: number): boolean;
    setOutputDatapoint(id: number, value: string): Promise<void>;
}

/** A virtual free@home device as created by the library. */
export interface DeviceHandle {
    channels: ChannelLike[];
    /** Renews the time-to-live of the device (also makes it reachable again). */
    triggerKeepAlive(): Promise<void>;
    setUnresponsive(): Promise<void>;
}

/** Virtual device types of the free@home Local API used by the addon. */
export type VirtualDeviceType =
    | "WeatherStation"
    | "AirQualityTemperature"
    | "AirQualityHumidity"
    | "AirQualityCO2"
    | "AirQualityPressure"
    | "AirQualityFull";

class FahChannel {
    private readonly written = new Map<number, string>();

    constructor(private readonly channel: ChannelLike, private readonly onWriteError: (id: number, value: string, error: unknown) => void) {}

    get parameters(): ReadonlyMap<number, string> {
        return this.channel.parameters;
    }

    /** Writes all outputs this channel has, each only when its value changed. */
    publish(values: SensorValues, log: Logger): void {
        for (const rule of OUTPUT_RULES) {
            if (!this.channel.hasOutput(rule.id))
                continue;
            const value = rule.value(values, this.channel.parameters);
            if (value === undefined || this.written.get(rule.id) === value)
                continue;
            this.written.set(rule.id, value);
            log.debug(`0x${rule.id.toString(16).padStart(4, "0")} = ${value}`);
            this.channel.setOutputDatapoint(rule.id, value).catch((error) => {
                this.written.delete(rule.id);
                this.onWriteError(rule.id, value, error);
            });
        }
    }

    resetOutputs(): void {
        this.written.clear();
    }
}

/**
 * A virtual free@home sensor device (weather station or air quality sensor). Values are
 * written to the outputs the device has; alarms are derived from the channel parameters and
 * updated as soon as a threshold is changed in the free@home app.
 */
export class FahDevice {
    private readonly channels: FahChannel[];
    private values: SensorValues = {};
    private available = true;

    constructor(
        readonly nativeId: string,
        readonly name: string,
        readonly type: VirtualDeviceType,
        private readonly handle: DeviceHandle,
        private readonly log = new Logger(`fah/${nativeId}`),
    ) {
        this.channels = handle.channels.map((channel) => {
            const wrapped = new FahChannel(channel, (id, value, error) =>
                this.log.warn(`could not set datapoint 0x${id.toString(16)}=${value}: ${errorMessage(error)}`));
            channel.onParameterChanged((id, value) => {
                this.log.debug(`parameter 0x${id.toString(16)} = ${value}`);
                if (this.available)
                    wrapped.publish(this.values, this.log);
            });
            return wrapped;
        });
    }

    get isAvailable(): boolean {
        return this.available;
    }

    get lastValues(): SensorValues {
        return this.values;
    }

    /** Shows new values (only changed datapoints are written). */
    update(values: SensorValues): void {
        this.values = { ...this.values, ...values };
        if (!this.available)
            return;
        for (const channel of this.channels)
            channel.publish(this.values, this.log);
    }

    /** Forgets the last written outputs so that all values are sent again. */
    resetOutputs(): void {
        for (const channel of this.channels)
            channel.resetOutputs();
    }

    /** Sends all values again, e.g. after the System Access Point restarted. */
    republish(): void {
        this.resetOutputs();
        this.update({});
    }

    /** Marks the device as (un)reachable in free@home. */
    async setAvailable(available: boolean): Promise<void> {
        if (available === this.available)
            return;
        this.available = available;
        this.log.info(available ? "reachable" : "not reachable");
        try {
            if (available) {
                await this.handle.triggerKeepAlive();
                // Send all values again, free@home may show outdated ones.
                this.republish();
            } else {
                await this.handle.setUnresponsive();
            }
        } catch (error) {
            this.log.warn(`could not update reachability: ${errorMessage(error)}`);
        }
    }

    /** Sends the regular life sign (renews the time-to-live of the virtual device). */
    async keepAlive(): Promise<void> {
        if (!this.available)
            return;
        try {
            await this.handle.triggerKeepAlive();
        } catch (error) {
            this.log.warn(`keep-alive failed: ${errorMessage(error)}`);
        }
    }
}
