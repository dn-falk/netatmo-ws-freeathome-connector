import { BridgeStatus, StationSources } from "./bridge/bridge";
import { SourceInfo } from "./bridge/weather";
import { Message } from "./config";
import { errorMessage } from "./log";
import { NetatmoError } from "./netatmo/errors";

export type OfflineReason = "auth" | "scope" | "rateLimit" | "appDeactivated" | "other";

export type AddonStatus =
    | { state: "starting" }
    | { state: "configurationNeeded"; problems: Message[] }
    | { state: "connecting" }
    | { state: "online"; stations: number; devices: number; sources: StationSources[] }
    | { state: "offline"; error: string; reason: OfflineReason; sources: StationSources[] };

export function fromBridgeStatus(status: BridgeStatus): AddonStatus {
    switch (status.state) {
        case "online":
            return { state: "online", stations: status.stations, devices: status.devices, sources: status.sources };
        case "offline": {
            const kind = status.error instanceof NetatmoError ? status.error.kind : undefined;
            const reason: OfflineReason = kind === "auth" || kind === "scope" || kind === "rateLimit" || kind === "appDeactivated" ? kind : "other";
            return { state: "offline", error: status.error ? errorMessage(status.error) : "unknown error", reason, sources: status.sources };
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

function isError(status: AddonStatus): boolean {
    return status.state === "offline" || status.state === "configurationNeeded";
}

/**
 * Parameter configuration returned by the `getParameterConfig` RPC: the status line
 * (parameter "status") or the data sources (parameter "currentSources").
 */
export function parameterConfig(status: AddonStatus, parameter?: string): Record<string, unknown> {
    const text = parameter === "currentSources" ? describeSources(status) : describeStatus(status);
    return {
        name: text.en,
        "name@de": text.de,
        type: parameter !== "currentSources" && isError(status) ? "error" : "text",
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
