import * as http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { VirtualDeviceType } from "../../src/fah/device";
import { CHANNEL_OUTPUTS } from "./fakes";

const SYSAP = "00000000-0000-0000-0000-000000000000";

interface VirtualDevice {
    serial: string;
    nativeId: string;
    type: VirtualDeviceType;
    displayName?: string;
    ttl: string;
    /** Output values per channel: pairing id -> value. */
    outputs: Map<number, string>[];
    /** Parameters per channel: parameter id -> value. */
    parameters: Map<number, string>[];
}

const hex = (value: number) => value.toString(16).padStart(4, "0");

/**
 * Minimal fake of the local API of a System Access Point (virtual devices with several
 * channels, datapoints, parameters, websocket, addon configuration/events/application state and
 * the addon RPC websocket). Lets the tests run the real addon (with the real free@home library).
 */
export class FakeSysap {
    readonly devices = new Map<string, VirtualDevice>();
    readonly applicationStates: unknown[] = [];
    /** Configurations written by the addon (PUT …/configuration). */
    readonly savedConfigurations: unknown[] = [];
    private readonly server = http.createServer((req, res) => this.handle(req, res));
    private readonly wss = new WebSocketServer({ noServer: true });
    private readonly fhSockets = new Set<WebSocket>();
    private rpcSocket: WebSocket | undefined;
    private readonly sseClients = new Map<string, http.ServerResponse[]>();
    private configuration: unknown;
    private nextSerial = 0x6000_0000_0001;
    private rpcId = 0;
    private readonly rpcWaiters = new Map<number, (result: unknown) => void>();

    constructor(private readonly addonId: string) {
        this.server.on("upgrade", (req, socket, head) => {
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                if (req.url === "/api/fhapi/v1/api/ws") {
                    this.fhSockets.add(ws);
                    ws.on("close", () => this.fhSockets.delete(ws));
                } else if (req.url === `/api/rpc/v1/${this.addonId}/websocket`) {
                    this.rpcSocket = ws;
                    ws.on("message", (data) => {
                        const message = JSON.parse(data.toString()) as { id: number; result?: unknown; error?: unknown };
                        this.rpcWaiters.get(message.id)?.(message.result ?? message.error);
                    });
                } else {
                    ws.close();
                }
            });
        });
    }

    async listen(): Promise<string> {
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async close(): Promise<void> {
        for (const clients of this.sseClients.values())
            clients.forEach((client) => client.end());
        this.wss.clients.forEach((client) => client.terminate());
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    get currentConfiguration(): unknown {
        return this.configuration;
    }

    /** Sends a new addon configuration (like saving the addon settings in the app). */
    setConfiguration(configuration: unknown): void {
        this.configuration = configuration;
        for (const client of this.sseClients.get("configuration") ?? [])
            client.write(`data: ${JSON.stringify(configuration)}\n\n`);
    }

    /** Sends an addon event, e.g. a button pressed in the addon settings. */
    sendEvent(event: Record<string, unknown>): void {
        for (const client of this.sseClients.get("events") ?? [])
            client.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    /** Changes a channel parameter (like a threshold set in the free@home app). */
    setParameter(nativeId: string, channel: number, parameterId: number, value: string): void {
        const device = this.device(nativeId);
        device.parameters[channel].set(parameterId, value);
        this.broadcast({ parameters: { [`${device.serial}/ch${hex(channel)}/par${hex(parameterId)}`]: value } });
    }

    /** Value of an output datapoint on any channel of the device. */
    output(nativeId: string, pairingId: number): string | undefined {
        const device = this.devices.get(nativeId);
        for (const outputs of device?.outputs ?? []) {
            if (outputs.has(pairingId))
                return outputs.get(pairingId);
        }
        return undefined;
    }

    rpc(method: string, params: unknown): Promise<unknown> {
        const socket = this.rpcSocket;
        if (!socket)
            return Promise.reject(new Error("addon RPC not connected"));
        const id = ++this.rpcId;
        return new Promise((resolve) => {
            this.rpcWaiters.set(id, resolve);
            socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    get rpcConnected(): boolean {
        return this.rpcSocket?.readyState === WebSocket.OPEN;
    }

    device(nativeId: string): VirtualDevice {
        const device = this.devices.get(nativeId);
        if (!device)
            throw new Error(`virtual device ${nativeId} not created`);
        return device;
    }

    private broadcast(content: Record<string, unknown>): void {
        const message = JSON.stringify({
            [SYSAP]: { datapoints: {}, devices: {}, devicesAdded: [], devicesRemoved: [], scenesTriggered: {}, parameters: {}, ...content },
        });
        this.fhSockets.forEach((socket) => socket.send(message));
    }

    private channelDescriptions(device: VirtualDevice) {
        return Object.fromEntries(CHANNEL_OUTPUTS[device.type].map((outputs, channel) => [`ch${hex(channel)}`, {
            displayName: device.displayName,
            inputs: {},
            outputs: Object.fromEntries(outputs.map((pairingID, index) => [`odp${hex(index)}`, { pairingID, value: "0" }])),
            parameters: Object.fromEntries([...device.parameters[channel]].map(([id, value]) => [`par${hex(id)}`, value])),
        }]));
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = req.url ?? "";
            const json = (status: number, payload: unknown) => {
                // With Content-Length: node-fetch 2 (used by the library) reports "Premature close"
                // for chunked responses on keep-alive connections.
                const text = Buffer.from(JSON.stringify(payload));
                res.writeHead(status, { "Content-Type": "application/json", "Content-Length": text.length });
                res.end(text);
            };

            // ---- addon (scripting) API
            const container = /^\/api\/scripting\/v1\/rest\/container\/([^/]+)\/(configuration|events|applicationstate)$/.exec(url);
            if (container) {
                if (req.method === "GET") {
                    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
                    const list = this.sseClients.get(container[2]) ?? [];
                    list.push(res);
                    this.sseClients.set(container[2], list);
                    if (container[2] === "configuration" && this.configuration !== undefined)
                        res.write(`data: ${JSON.stringify(this.configuration)}\n\n`);
                    return;
                }
                if (req.method === "PUT" && container[2] === "applicationstate") {
                    this.applicationStates.push(JSON.parse(body));
                    return json(200, {});
                }
                if (req.method === "PUT" && container[2] === "configuration") {
                    const configuration = JSON.parse(body) as unknown;
                    this.savedConfigurations.push(configuration);
                    // Like the System Access Point: the new configuration is sent to the addon.
                    this.setConfiguration(configuration);
                    return json(200, {});
                }
                return json(200, {});
            }

            // ---- local API: virtual devices
            const virtualDevice = /^\/api\/fhapi\/v1\/api\/rest\/virtualdevice\/([^/]+)\/([^/]+)$/.exec(url);
            if (virtualDevice && req.method === "PUT") {
                const nativeId = decodeURIComponent(virtualDevice[2]);
                const request = JSON.parse(body) as { type: VirtualDeviceType; properties?: Record<string, string> };
                let device = this.devices.get(nativeId);
                if (!device) {
                    const channels = CHANNEL_OUTPUTS[request.type];
                    if (!channels)
                        return json(400, { error: `unknown device type ${request.type}` });
                    device = {
                        serial: (this.nextSerial++).toString(16).toUpperCase().padStart(12, "0"),
                        nativeId,
                        type: request.type,
                        displayName: request.properties?.displayname,
                        ttl: request.properties?.ttl ?? "180",
                        outputs: channels.map(() => new Map()),
                        parameters: channels.map(() => new Map()),
                    };
                    this.devices.set(nativeId, device);
                }
                device.ttl = request.properties?.ttl ?? device.ttl;
                return json(200, { [SYSAP]: { devices: { [device.serial]: { serial: nativeId } } } });
            }

            const getDevice = /^\/api\/fhapi\/v1\/api\/rest\/device\/([^/]+)\/([^/]+)$/.exec(url);
            if (getDevice && req.method === "GET") {
                const device = [...this.devices.values()].find((candidate) => candidate.serial === getDevice[2]);
                if (!device)
                    return json(404, {});
                return json(200, { [SYSAP]: { devices: { [device.serial]: { channels: this.channelDescriptions(device) } } } });
            }

            const datapoint = /^\/api\/fhapi\/v1\/api\/rest\/datapoint\/([^/]+)\/([0-9A-F]+)\.ch([0-9a-f]{4})\.odp([0-9a-f]{4})$/i.exec(url);
            if (datapoint && req.method === "PUT") {
                const device = [...this.devices.values()].find((candidate) => candidate.serial === datapoint[2]);
                const channel = parseInt(datapoint[3], 16);
                const pairingId = device ? CHANNEL_OUTPUTS[device.type][channel]?.[parseInt(datapoint[4], 16)] : undefined;
                if (!device || pairingId === undefined)
                    return json(404, {});
                device.outputs[channel].set(pairingId, body);
                return json(200, { [SYSAP]: { values: [body] } });
            }

            return json(404, { error: `not implemented: ${req.method} ${url}` });
        });
    }
}
