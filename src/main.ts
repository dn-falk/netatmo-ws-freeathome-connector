// Only the needed parts of the library are loaded: the package index also loads the serial port
// support (rewiremock, serialport), which costs several MB of the 64 MB an addon may use.
// The deep imports are safe because the library version is pinned in package.json.
import * as AddOn from "@busch-jaeger/free-at-home/lib/addon";
import type { ApiVirtualChannel } from "@busch-jaeger/free-at-home/lib/api/apiVirtualChannel";
import { FreeAtHome } from "@busch-jaeger/free-at-home/lib/freeAtHome";
import { RpcWebsocket } from "@busch-jaeger/free-at-home/lib/rpcWebsocket";

import { App } from "./app";
import { ChannelLike, DeviceHandle } from "./fah/device";
import { FahDeviceRegistry } from "./fah/registry";
import { Logger, errorMessage } from "./log";
import { applicationState, parameterConfig } from "./status";

const log = new Logger("main");
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Adapts a channel of the library to the interface the addon uses. */
function channelLike(channel: ApiVirtualChannel): ChannelLike {
    return {
        parameters: channel.parameters as ReadonlyMap<number, string>,
        onParameterChanged: (listener) => {
            channel.on("parameterChanged", (id, value) => listener(id, String(value)));
        },
        hasOutput: (id) => channel.outputPairingToPosition.has(id),
        setOutputDatapoint: (id, value) => channel.setOutputDatapoint(id, value),
    };
}

function main(): void {
    const metaData = AddOn.readMetaData();
    log.info(`starting ${metaData.id} ${metaData.version}`);

    const freeAtHome = new FreeAtHome();
    const registry = new FahDeviceRegistry({
        createDevice: async (nativeId, name, type): Promise<DeviceHandle> => {
            const device = await freeAtHome.freeAtHomeApi.createDevice(type, nativeId, name);
            return {
                channels: [...device.getChannels()].map(channelLike),
                triggerKeepAlive: () => device.triggerKeepAlive(),
                setUnresponsive: () => device.setUnresponsive(),
            };
        },
    });
    registry.startKeepAlive();

    const addOn = new AddOn.AddOn(metaData.id);
    const app = new App({
        registry,
        publishStatus: (status) => {
            Promise.resolve(addOn.setApplicationState(applicationState(status) as unknown as AddOn.ApplicationState))
                .catch((error) => log.debug(`could not publish application state: ${errorMessage(error)}`));
        },
        saveConfiguration: (configuration) => addOn.setConfiguration(configuration as unknown as AddOn.Configuration),
    });

    addOn.on("configurationChanged", (configuration) => {
        log.info("configuration received");
        void app.applyConfiguration(configuration);
    });
    addOn.on("event", (event) => {
        if (event.eventType === "buttonPressed" && event.parameter === "resync")
            app.resync();
    });
    addOn.connectToConfiguration();
    addOn.connectToEvents();

    // Status lines in the addon settings (parameters "status" and "currentSources", see free-at-home-metadata.json).
    const rpc = new RpcWebsocket(metaData.id);
    rpc.addMethod("getParameterConfig", (params?: { $parameter?: string }) => parameterConfig(app.getStatus(), params?.$parameter));

    // After a restart of the System Access Point: life sign and all values again.
    freeAtHome.on("open", () => {
        void registry.keepAliveAll();
        void app.republish();
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.info(`${signal} received, shutting down`);
        const cleanup = async () => {
            registry.stopKeepAlive();
            await app.shutdown();
            await freeAtHome.markAllDevicesAsUnresponsive();
        };
        const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
        Promise.race([cleanup(), timeout])
            .catch((error) => log.error(`error during shutdown: ${errorMessage(error)}`))
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
    log.error(`unhandled rejection: ${errorMessage(reason)}`, reason);
});

main();
