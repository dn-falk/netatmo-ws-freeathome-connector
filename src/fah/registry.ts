import { Logger, errorMessage } from "../log";
import { DeviceHandle, FahDevice, VirtualDeviceType } from "./device";

export interface VirtualDeviceFactory {
    /** Creates (or reuses) the virtual free@home device with the given id. */
    createDevice(nativeId: string, name: string, type: VirtualDeviceType): Promise<DeviceHandle>;
}

/**
 * Every life sign sets the time-to-live of the virtual device (30 min with free@home library
 * 0.37); without a new one the System Access Point shows the device as unreachable.
 */
export const KEEP_ALIVE_INTERVAL_MS = 10 * 60_000;

/**
 * Owns the virtual free@home devices for the whole lifetime of the addon.
 *
 * Devices are created only once, even if the configuration changes and the connection to
 * Netatmo is rebuilt: every creation would register further listeners on the library's channels.
 */
export class FahDeviceRegistry {
    private readonly devices = new Map<string, Promise<FahDevice>>();
    private keepAliveTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly factory: VirtualDeviceFactory,
        private readonly log = new Logger("fah"),
        private readonly keepAliveIntervalMs = KEEP_ALIVE_INTERVAL_MS,
    ) {}

    getOrCreate(nativeId: string, name: string, type: VirtualDeviceType): Promise<FahDevice> {
        let device = this.devices.get(nativeId);
        if (!device) {
            this.log.info(`creating free@home device '${name}' (${type}, ${nativeId})`);
            device = this.factory.createDevice(nativeId, name, type)
                .then((handle) => new FahDevice(nativeId, name, type, handle, this.log.child(nativeId)));
            // Allow a new attempt if the creation failed.
            device.catch((error) => {
                this.log.error(`could not create free@home device ${nativeId}: ${errorMessage(error)}`);
                this.devices.delete(nativeId);
            });
            this.devices.set(nativeId, device);
        }
        return device;
    }

    startKeepAlive(): void {
        if (this.keepAliveTimer)
            return;
        this.keepAliveTimer = setInterval(() => void this.keepAliveAll(), this.keepAliveIntervalMs);
    }

    stopKeepAlive(): void {
        if (this.keepAliveTimer)
            clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
    }

    async keepAliveAll(): Promise<void> {
        await Promise.all((await this.createdDevices()).map((device) => device.keepAlive()));
    }

    /** Marks all devices as (un)reachable, e.g. while the addon is not configured. */
    async setAllAvailable(available: boolean): Promise<void> {
        await Promise.all((await this.createdDevices()).map((device) => device.setAvailable(available)));
    }

    /** Forgets the last written outputs and sends all values again. */
    async republishAll(): Promise<void> {
        for (const device of await this.createdDevices())
            device.republish();
    }

    async createdDevices(): Promise<FahDevice[]> {
        const results = await Promise.allSettled(this.devices.values());
        return results
            .filter((result): result is PromiseFulfilledResult<FahDevice> => result.status === "fulfilled")
            .map((result) => result.value);
    }
}
