import { EventEmitter } from "node:events";

import { PairingId } from "../../src/fah/datapoints";
import { ChannelLike, DeviceHandle, FahDevice, VirtualDeviceType } from "../../src/fah/device";

/** Output datapoints of the channels of each virtual device type (see test/support/fakeSysap.ts). */
export const CHANNEL_OUTPUTS: Record<VirtualDeviceType, number[][]> = {
    WeatherStation: [
        [PairingId.AL_BRIGHTNESS_LEVEL, PairingId.AL_BRIGHTNESS_ALARM],
        [PairingId.AL_RAIN_ALARM, 0x0405, 0x0406],
        [PairingId.AL_OUTDOOR_TEMPERATURE, PairingId.AL_FROST_ALARM],
        [PairingId.AL_WIND_SPEED, PairingId.AL_WIND_FORCE, PairingId.AL_WIND_ALARM],
    ],
    AirQualityTemperature: [[PairingId.AL_MEASURED_TEMPERATURE]],
    AirQualityHumidity: [[PairingId.AL_HUMIDITY]],
    AirQualityCO2: [[PairingId.AL_INFO_CO_2]],
    AirQualityPressure: [[PairingId.AL_INFO_PRESSURE]],
    AirQualityFull: [[
        PairingId.AL_INFO_CO_2, 0x061C, PairingId.AL_HUMIDITY, 0x061D, 0x061E, 0x061F, 0x0620,
        PairingId.AL_INFO_PRESSURE, PairingId.AL_MEASURED_TEMPERATURE, 0x0621,
    ]],
};

/** Stands in for a channel of a virtual free@home device. */
export class FakeChannel extends EventEmitter implements ChannelLike {
    readonly parameters = new Map<number, string>();
    readonly outputs = new Map<number, string>();
    readonly writes: { id: number; value: string }[] = [];

    constructor(private readonly outputIds: number[]) {
        super();
    }

    onParameterChanged(listener: (id: number, value: string) => void): void {
        this.on("parameterChanged", listener);
    }

    hasOutput(id: number): boolean {
        return this.outputIds.includes(id);
    }

    async setOutputDatapoint(id: number, value: string): Promise<void> {
        this.outputs.set(id, value);
        this.writes.push({ id, value });
    }

    /** Simulates a parameter change in the free@home app. */
    setParameter(id: number, value: string): void {
        this.parameters.set(id, value);
        this.emit("parameterChanged", id, value);
    }
}

export class FakeHandle implements DeviceHandle {
    readonly channels: FakeChannel[];
    keepAlives = 0;
    unresponsiveCalls = 0;

    constructor(type: VirtualDeviceType) {
        this.channels = CHANNEL_OUTPUTS[type].map((outputs) => new FakeChannel(outputs));
    }

    async triggerKeepAlive(): Promise<void> {
        this.keepAlives++;
    }

    async setUnresponsive(): Promise<void> {
        this.unresponsiveCalls++;
    }

    /** Value of an output datapoint on any channel. */
    output(id: number): string | undefined {
        for (const channel of this.channels) {
            if (channel.outputs.has(id))
                return channel.outputs.get(id);
        }
        return undefined;
    }

    channelWith(id: number): FakeChannel {
        const channel = this.channels.find((candidate) => candidate.hasOutput(id));
        if (!channel)
            throw new Error(`no channel with output 0x${id.toString(16)}`);
        return channel;
    }
}

/** Device registry backed by fake handles. */
export class FakeRegistry {
    readonly handles = new Map<string, FakeHandle>();
    readonly devices = new Map<string, FahDevice>();

    async getOrCreate(nativeId: string, name: string, type: VirtualDeviceType): Promise<FahDevice> {
        let device = this.devices.get(nativeId);
        if (!device) {
            const handle = new FakeHandle(type);
            device = new FahDevice(nativeId, name, type, handle);
            this.handles.set(nativeId, handle);
            this.devices.set(nativeId, device);
        }
        return device;
    }

    async createdDevices(): Promise<FahDevice[]> {
        return [...this.devices.values()];
    }

    async setAllAvailable(available: boolean): Promise<void> {
        await Promise.all([...this.devices.values()].map((device) => device.setAvailable(available)));
    }

    async republishAll(): Promise<void> {
        for (const device of this.devices.values())
            device.republish();
    }

    handle(nativeId: string): FakeHandle {
        const handle = this.handles.get(nativeId);
        if (!handle)
            throw new Error(`no free@home device ${nativeId}`);
        return handle;
    }

    device(nativeId: string): FahDevice {
        const device = this.devices.get(nativeId);
        if (!device)
            throw new Error(`no free@home device ${nativeId}`);
        return device;
    }
}

export async function waitFor(condition: () => boolean, timeoutMs = 3_000, what = "condition"): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs)
            throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
