import * as http from "node:http";
import { AddressInfo } from "node:net";

import { Logger, errorMessage } from "./log";
import { SIGNATURE_HEADER, verifySignature } from "./netatmo/webhook";

/** A webhook body is a few kB; anything much larger is not from Netatmo. */
const MAX_BODY_BYTES = 256 * 1024;
/** Netatmo expects the answer within 5 seconds. */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 32;
/** Rejected requests are logged at most this often (the port is reachable from the internet). */
const REJECT_LOG_INTERVAL_MS = 10 * 60_000;

export interface WebhookServerOptions {
    port: number;
    /** Default: all interfaces. */
    host?: string;
    /** Key of the signatures (client secret of the Netatmo app). */
    clientSecret: string;
    /** Called with every body whose signature is valid, after the answer was sent. */
    onEvent(body: unknown): void;
    log?: Logger;
}

/**
 * Receives the webhooks of Netatmo: accepts only POST requests whose body carries a valid
 * signature (HMAC-SHA256 with the client secret), answers right away and hands the body on.
 * A GET request gets a short text, so the forwarding can be checked in a browser.
 */
export class WebhookServer {
    /** Requests rejected because of a missing or wrong signature. */
    rejected = 0;
    private server: http.Server | undefined;
    private lastRejectLog = 0;
    private readonly log: Logger;

    constructor(private readonly options: WebhookServerOptions) {
        this.log = options.log ?? new Logger("webhook");
    }

    /** Starts listening; resolves with the port, rejects if the port cannot be opened. */
    start(): Promise<number> {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.requestTimeout = REQUEST_TIMEOUT_MS;
        server.headersTimeout = REQUEST_TIMEOUT_MS;
        server.keepAliveTimeout = 5_000;
        server.maxHeadersCount = 64;
        server.maxConnections = MAX_CONNECTIONS;
        this.server = server;
        return new Promise<number>((resolve, reject) => {
            const failed = (error: Error) => {
                this.server = undefined;
                reject(error);
            };
            server.once("error", failed);
            server.listen(this.options.port, this.options.host, () => {
                server.off("error", failed);
                server.on("error", (error) => this.log.warn(`webhook server: ${errorMessage(error)}`));
                resolve((server.address() as AddressInfo).port);
            });
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (!server)
            return;
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const answer = (status: number, body: string, type = "text/plain; charset=utf-8", headers: http.OutgoingHttpHeaders = {}) => {
            if (res.headersSent)
                return;
            res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
            res.end(req.method === "HEAD" ? undefined : body);
        };
        if (req.method === "GET" || req.method === "HEAD") {
            answer(200, "Netatmo-Weather-Connector for free@home: webhook endpoint (Netatmo sends POST requests here)\n");
            req.resume();
            return;
        }
        if (req.method !== "POST") {
            answer(405, "method not allowed\n", undefined, { Allow: "GET, HEAD, POST" });
            req.resume();
            return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk: Buffer) => {
            if (tooLarge)
                return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                answer(413, "payload too large\n", undefined, { Connection: "close" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("error", () => undefined);
        req.on("end", () => {
            if (tooLarge)
                return;
            const raw = Buffer.concat(chunks);
            const signature = req.headers[SIGNATURE_HEADER];
            if (!verifySignature(raw, this.options.clientSecret, Array.isArray(signature) ? signature[0] : signature)) {
                this.reject(req, signature === undefined ? "without signature" : "with an invalid signature");
                answer(401, "invalid signature\n");
                return;
            }
            let body: unknown;
            try {
                body = JSON.parse(raw.toString("utf8"));
            } catch {
                answer(400, "invalid JSON\n");
                return;
            }
            answer(200, JSON.stringify({ status: "ok" }), "application/json");
            setImmediate(() => {
                try {
                    this.options.onEvent(body);
                } catch (error) {
                    this.log.error(`could not process a webhook: ${errorMessage(error)}`, error);
                }
            });
        });
    }

    private reject(req: http.IncomingMessage, reason: string): void {
        this.rejected++;
        const now = Date.now();
        const message = `rejected a webhook request ${reason} from ${req.socket.remoteAddress ?? "?"}`
            + " (not from Netatmo, or the client secret in the settings is not the one of the app)";
        if (now - this.lastRejectLog >= REJECT_LOG_INTERVAL_MS) {
            this.lastRejectLog = now;
            this.log.info(`${message}; ${this.rejected} rejected so far`);
        } else {
            this.log.debug(message);
        }
    }
}
