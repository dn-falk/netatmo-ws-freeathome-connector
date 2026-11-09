import { LiveValues, WebhookEvent, valueCount } from "../netatmo/webhook";
import { ModuleData, StationData, allModules } from "../netatmo/stations";

/** Values of a module received by webhook that are newer than the last query of the station data. */
interface Overlay {
    /** Time of the values (ms). */
    time: number;
    /** When the latest of the values arrived. */
    receivedAt: number;
    values: LiveValues;
}

export interface AppliedEvent {
    /** Modules of the own stations with new values. */
    updated: ModuleData[];
    /** Modules of the own stations reported as not reachable (their values are not used). */
    unreachable: ModuleData[];
    /** Modules that are not (yet) known from the station data, e.g. newly added. */
    unknown: string[];
    /** Modules whose values were older than the known ones (late or repeated delivery). */
    outdated: number;
}

/** Netatmo times slightly ahead of the clock of the System Access Point are accepted. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

/**
 * Measurements of the webhooks of Netatmo, laid over the station data of the last query.
 *
 * Netatmo does not guarantee the order of the webhooks and sometimes delivers one twice, so
 * values are only taken if they are not older than the known ones. A module counts as
 * "covered" while webhooks keep bringing its values; only then can the queries of the station
 * data become rare without the module looking stale.
 */
export class LiveData {
    private readonly overlays = new Map<string, Overlay>();
    /** Last time a webhook brought current values of the module. */
    private readonly receivedAt = new Map<string, number>();
    /** Last valid device event for one of the own stations. */
    lastEventAt: number | undefined;

    /** Takes the values of a device event for the modules of `stations` (the last query). */
    apply(event: WebhookEvent, stations: StationData[], now: number): AppliedEvent {
        const result: AppliedEvent = { updated: [], unreachable: [], unknown: [], outdated: 0 };
        const modules = new Map(stations.flatMap(allModules).map((module) => [module.id.toLowerCase(), module]));
        const ownGateway = event.deviceId !== undefined && modules.has(event.deviceId);
        for (const entry of event.modules) {
            const module = modules.get(entry.id);
            if (!module) {
                if (ownGateway)
                    result.unknown.push(entry.id);
                continue;
            }
            if (entry.reachable === false) {
                result.unreachable.push(module);
                continue;
            }
            if (valueCount(entry.values) === 0)
                continue;
            const time = entry.time !== undefined && entry.time <= now + CLOCK_TOLERANCE_MS ? Math.min(entry.time, now) : now;
            const overlay = this.overlays.get(module.id);
            const known = Math.max(module.time ?? 0, overlay?.time ?? 0);
            if (time < known) {
                result.outdated++;
                continue;
            }
            this.receivedAt.set(module.id, now);
            if (time > (module.time ?? 0)) {
                // Fields missing in an event keep their last value (an event need not contain all).
                this.overlays.set(module.id, { time, receivedAt: now, values: { ...overlay?.values, ...entry.values } });
            }
            result.updated.push(module);
        }
        if (result.updated.length > 0 || result.unreachable.length > 0)
            this.lastEventAt = now;
        return result;
    }

    /** The station data with the newer values of the webhooks. */
    merge(stations: StationData[]): StationData[] {
        if (this.overlays.size === 0)
            return stations;
        const mergeModule = (module: ModuleData): ModuleData => {
            const overlay = this.overlays.get(module.id);
            if (!overlay || (module.time ?? 0) >= overlay.time)
                return module;
            return { ...module, ...definedValues(overlay.values), time: overlay.time, reachable: true };
        };
        return stations.map((station) => ({ ...station, main: mergeModule(station.main), modules: station.modules.map(mergeModule) }));
    }

    /**
     * Forgets values the station data has caught up with, those of removed modules and those of
     * modules the station data reports as not reachable (unless the values arrived after the
     * query was sent at `queriedAt`: the module is back then).
     */
    prune(stations: StationData[], queriedAt: number): void {
        const modules = new Map(stations.flatMap(allModules).map((module) => [module.id, module]));
        for (const [id, overlay] of this.overlays) {
            const module = modules.get(id);
            if (!module || (module.time ?? 0) >= overlay.time || (!module.reachable && overlay.receivedAt <= queriedAt))
                this.overlays.delete(id);
        }
        for (const id of this.receivedAt.keys()) {
            if (!modules.has(id))
                this.receivedAt.delete(id);
        }
    }

    /** True if a webhook brought current values of the module within the last `windowMs`. */
    covered(moduleId: string, now: number, windowMs: number): boolean {
        const time = this.receivedAt.get(moduleId);
        return time !== undefined && now - time <= windowMs;
    }
}

function definedValues(values: LiveValues): LiveValues {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as LiveValues;
}
