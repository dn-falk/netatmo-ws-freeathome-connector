import { BridgeStatus, StationSources } from "./bridge/bridge";
import { WebhookStatus } from "./bridge/webhook";
import { SourceInfo } from "./bridge/weather";
import { Message } from "./config";
import { errorMessage } from "./log";
import { NetatmoError } from "./netatmo/errors";

export type OfflineReason = "auth" | "scope" | "rateLimit" | "appDeactivated" | "other";

export type AddonStatus =
    | { state: "starting" }
    | { state: "configurationNeeded"; problems: Message[] }
    | { state: "connecting" }
    | { state: "online"; stations: number; devices: number; plannedDevices: number; sources: StationSources[]; complete: boolean; webhook?: WebhookStatus }
    | { state: "offline"; error: string; reason: OfflineReason; sources: StationSources[]; webhook?: WebhookStatus };

export function fromBridgeStatus(status: BridgeStatus): AddonStatus {
    switch (status.state) {
        case "online":
            return {
                state: "online",
                stations: status.stations,
                devices: status.devices,
                plannedDevices: status.plannedDevices,
                sources: status.sources,
                complete: status.complete,
                ...(status.webhook ? { webhook: status.webhook } : {}),
            };
        case "offline": {
            const kind = status.error instanceof NetatmoError ? status.error.kind : undefined;
            const reason: OfflineReason = kind === "auth" || kind === "scope" || kind === "rateLimit" || kind === "appDeactivated" ? kind : "other";
            return {
                state: "offline",
                error: status.error ? errorMessage(status.error) : "unknown error",
                reason,
                sources: status.sources,
                ...(status.webhook ? { webhook: status.webhook } : {}),
            };
        }
        default:
            return { state: "connecting" };
    }
}

export function describeStatus(status: AddonStatus): Message {
    switch (status.state) {
        case "starting":
            return { en: "Starting", de: "Wird gestartet" };
        case "configurationNeeded": {
            const problems = status.problems.length > 0 ? status.problems : [{ en: "settings missing", de: "Einstellungen fehlen" }];
            return {
                en: `Configuration needed: ${problems.map((problem) => problem.en).join(", ")}`,
                de: `Konfiguration nötig: ${problems.map((problem) => problem.de).join(", ")}`,
            };
        }
        case "connecting":
            return { en: "Connecting to Netatmo …", de: "Verbinde mit Netatmo …" };
        case "online":
            if (status.stations === 0)
                return { en: "Connected, but the Netatmo account has no weather station", de: "Verbunden, aber das Netatmo-Konto hat keine Wetterstation" };
            if (!status.complete) {
                const planned = status.plannedDevices;
                return {
                    en: `Connected, ${status.stations} station(s), setting up the free@home devices${planned ? ` (${status.devices} of ${planned})` : ""} …`,
                    de: `Verbunden, ${status.stations} Station(en), free@home-Geräte werden eingerichtet${planned ? ` (${status.devices} von ${planned})` : ""} …`,
                };
            }
            return {
                en: `Connected, ${status.stations} station(s), ${status.devices} free@home device(s)`,
                de: `Verbunden, ${status.stations} Station(en), ${status.devices} free@home-Geräte`,
            };
        case "offline":
            switch (status.reason) {
                case "auth":
                    return {
                        en: `Netatmo rejects the token, please generate a new refresh token (${status.error})`,
                        de: `Netatmo lehnt den Token ab, bitte einen neuen Refresh Token erzeugen (${status.error})`,
                    };
                case "scope":
                    return {
                        en: "The token lacks the scope read_station, please generate a new one with this scope",
                        de: "Dem Token fehlt der Scope read_station, bitte einen neuen mit diesem Scope erzeugen",
                    };
                case "appDeactivated":
                    return {
                        en: "The Netatmo app was deactivated, please activate it again on dev.netatmo.com (My apps)",
                        de: "Die Netatmo-App wurde deaktiviert, bitte auf dev.netatmo.com (My apps) wieder aktivieren",
                    };
                case "rateLimit":
                    return {
                        en: "Too many requests to Netatmo, waiting (other apps using the same Netatmo app?)",
                        de: "Zu viele Anfragen an Netatmo, warte (nutzen andere Programme dieselbe Netatmo-App?)",
                    };
                default:
                    return { en: `Netatmo not reachable (${status.error})`, de: `Netatmo nicht erreichbar (${status.error})` };
            }
    }
}

function describeSource(source: SourceInfo, own: Message): Message {
    switch (source.kind) {
        case "own":
            return own;
        case "public":
            return source.raining !== undefined
                ? {
                    en: `weather map (${source.raining}/${source.stations} gauges with rain)`,
                    de: `Wetterkarte (${source.raining}/${source.stations} Messer mit Regen)`,
                }
                : { en: `weather map (${source.stations} stations)`, de: `Wetterkarte (${source.stations} Stationen)` };
        case "off":
            return { en: "off", de: "aus" };
        case "none":
            return { en: "no data", de: "keine Daten" };
    }
}

function describeBrightness(brightness: StationSources["brightness"]): Message {
    if (!brightness)
        return { en: "off", de: "aus" };
    if (brightness.source === "none")
        return { en: "location unknown", de: "Standort unbekannt" };
    const lux = `${brightness.lux} lx`;
    if (brightness.fallback)
        return { en: `${lux} calculated (weather service not available)`, de: `${lux} berechnet (Wetterdienst nicht erreichbar)` };
    switch (brightness.source) {
        case "openmeteo":
            return { en: `${lux} Open-Meteo`, de: `${lux} Open-Meteo` };
        case "brightsky":
            return { en: `${lux} DWD`, de: `${lux} DWD` };
        default:
            return { en: `${lux} calculated`, de: `${lux} berechnet` };
    }
}

/** Where the values of the weather station of one Netatmo station come from. */
export function describeStationSources(entry: StationSources): Message {
    const temperature = describeSource(entry.temperature, { en: "outdoor module", de: "Außenmodul" });
    const rain = describeSource(entry.rain, { en: "rain gauge", de: "Regenmesser" });
    const wind = describeSource(entry.wind, { en: "wind gauge", de: "Windmesser" });
    const brightness = describeBrightness(entry.brightness);
    return {
        en: `temperature ${temperature.en} · rain ${rain.en} · wind ${wind.en} · brightness ${brightness.en}`,
        de: `Temperatur ${temperature.de} · Regen ${rain.de} · Wind ${wind.de} · Helligkeit ${brightness.de}`,
    };
}

/** Where the values of the weather station(s) come from, for the addon settings. */
export function describeSources(status: AddonStatus): Message {
    const sources = status.state === "online" || status.state === "offline" ? status.sources : [];
    if (sources.length === 0)
        return { en: "No weather station data yet", de: "Noch keine Daten der Wetterstation" };
    const parts = sources.map((entry) => {
        const text = describeStationSources(entry);
        const prefix = sources.length > 1 ? `${entry.station}: ` : "";
        return { en: prefix + text.en, de: prefix + text.de };
    });
    return { en: parts.map((part) => part.en).join(" | "), de: parts.map((part) => part.de).join(" | ") };
}

function ago(now: number, time: number): Message {
    const minutes = Math.round(Math.max(0, now - time) / 60_000);
    return minutes < 1
        ? { en: "less than a minute ago", de: "vor weniger als einer Minute" }
        : { en: `${minutes} min ago`, de: `vor ${minutes} min` };
}

/** Whether the webhook status is a problem the user has to solve. */
function webhookError(webhook: WebhookStatus): boolean {
    return (!webhook.listening && webhook.listenError !== undefined) || webhook.registration === "failed";
}

/** Status of the webhook, for the addon settings. */
export function describeWebhook(status: AddonStatus, now = Date.now()): Message {
    if (status.state === "starting" || status.state === "connecting")
        return { en: "Waiting for the connection to Netatmo …", de: "Wartet auf die Verbindung zu Netatmo …" };
    if (status.state === "configurationNeeded")
        return describeStatus(status);
    const webhook = status.webhook;
    const polling = { en: "the addon keeps querying Netatmo regularly", de: "das Addon fragt Netatmo weiter regelmäßig ab" };
    if (!webhook)
        return { en: "Off: the addon queries the values regularly from Netatmo", de: "Aus: das Addon fragt die Werte regelmäßig bei Netatmo ab" };
    if (!webhook.listening) {
        return webhook.listenError !== undefined
            ? {
                en: `Port ${webhook.port} could not be opened (${webhook.listenError}); ${polling.en}`,
                de: `Port ${webhook.port} konnte nicht geöffnet werden (${webhook.listenError}); ${polling.de}`,
            }
            : { en: "Starting …", de: "Wird gestartet …" };
    }
    switch (webhook.registration) {
        case "pending":
            return { en: `Listening on port ${webhook.port}, registering with Netatmo …`, de: `Empfang auf Port ${webhook.port}, Anmeldung bei Netatmo …` };
        case "failed":
            if (webhook.registrationStatus === 403) {
                return {
                    en: `Netatmo does not allow webhooks for this app (HTTP 403); ${polling.en}`,
                    de: `Netatmo erlaubt dieser App keine Webhooks (HTTP 403); ${polling.de}`,
                };
            }
            return {
                en: `Netatmo did not accept the webhook (${webhook.registrationError}), next attempt later; ${polling.en}`,
                de: `Netatmo hat den Webhook nicht angenommen (${webhook.registrationError}), neuer Versuch später; ${polling.de}`,
            };
        default:
            break;
    }
    if (webhook.lastEventAt === undefined) {
        if (webhook.rejected > 0) {
            return {
                en: `Requests arrive, but without a valid signature (${webhook.rejected} rejected): is the client secret the one of the app? ${polling.en}`,
                de: `Anfragen kommen an, aber ohne gültige Signatur (${webhook.rejected} abgewiesen): stimmt das Client Secret der App? ${polling.de}`,
            };
        }
        return {
            en: `Registered with Netatmo, no webhook received yet: does ${webhook.url} lead to port ${webhook.port} of the System Access Point? Until then ${polling.en}`,
            de: `Bei Netatmo angemeldet, noch kein Webhook empfangen: führt ${webhook.url} auf Port ${webhook.port} des System Access Point? Bis dahin ${polling.de}`,
        };
    }
    const last = ago(now, webhook.lastEventAt);
    if (webhook.active) {
        return {
            en: `Active, last webhook ${last.en}; the station data is only queried once per hour`,
            de: `Aktiv, letzter Webhook ${last.de}; die Stationsdaten werden nur noch stündlich abgefragt`,
        };
    }
    return {
        en: `Last webhook ${last.en}; it does not bring current values of all modules, so ${polling.en}`,
        de: `Letzter Webhook ${last.de}; er bringt nicht für alle Module aktuelle Werte, deshalb fragt das Addon Netatmo weiter regelmäßig ab`,
    };
}

/**
 * Whether the status is worth showing in the addon settings, which ask for it only once when
 * they are opened (also right after saving, which reconnects): not while connecting and not
 * before the first update after connecting has finished.
 */
export function isSettled(status: AddonStatus): boolean {
    switch (status.state) {
        case "starting":
        case "connecting":
            return false;
        case "online":
            return status.complete;
        default:
            return true;
    }
}

function isError(status: AddonStatus): boolean {
    return status.state === "offline" || status.state === "configurationNeeded";
}

/**
 * Parameter configuration returned by the `getParameterConfig` RPC: the status line
 * (parameter "status"), the data sources (parameter "currentSources") or the state of the
 * webhook (parameter "webhookStatus").
 */
export function parameterConfig(status: AddonStatus, parameter?: string, now = Date.now()): Record<string, unknown> {
    let text: Message;
    let error: boolean;
    if (parameter === "currentSources") {
        text = describeSources(status);
        error = false;
    } else if (parameter === "webhookStatus") {
        text = describeWebhook(status, now);
        const webhook = status.state === "online" || status.state === "offline" ? status.webhook : undefined;
        error = webhook !== undefined && webhookError(webhook);
    } else {
        text = describeStatus(status);
        error = isError(status);
    }
    return {
        name: text.en,
        "name@de": text.de,
        type: error ? "error" : "text",
        rpc: "getParameterConfig",
        rpcCallOn: "initial",
    };
}

/** Application state shown by the System Access Point for the addon. */
export function applicationState(status: AddonStatus): Record<string, unknown> {
    const text = describeStatus(status).de;
    const id = status.state === "configurationNeeded" ? "configurationNeeded"
        : status.state === "offline" ? "error" : "ok";
    return { state: { id, text } };
}
