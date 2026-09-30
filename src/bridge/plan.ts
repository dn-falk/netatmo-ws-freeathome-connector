import { IndoorSensorMode, NameLanguage, normaliseName } from "../config";
import { VirtualDeviceType } from "../fah/device";
import { ModuleData, StationData } from "../netatmo/stations";

export type Quantity = "temperature" | "humidity" | "co2" | "pressure";

/** A free@home device the addon provides for the current station data and settings. */
export interface PlannedDevice {
    nativeId: string;
    name: string;
    type: VirtualDeviceType;
    stationId: string;
    /** Module whose values the device shows; undefined for the weather station. */
    moduleId?: string;
    /** Values of the module shown by the device. */
    quantities: Quantity[];
}

export interface PlanSettings {
    weatherStation: boolean;
    indoorSensors: IndoorSensorMode;
    outdoorHumidity: boolean;
    excluded: string[];
    nameLanguage: NameLanguage;
}

const NAMES: Record<NameLanguage, Record<Quantity | "weatherStation" | "airQuality", string>> = {
    de: {
        weatherStation: "Wetterstation",
        temperature: "Temperatur",
        humidity: "Luftfeuchte",
        co2: "CO2",
        pressure: "Luftdruck",
        airQuality: "Raumklima",
    },
    en: {
        weatherStation: "Weather station",
        temperature: "Temperature",
        humidity: "Humidity",
        co2: "CO2",
        pressure: "Air pressure",
        airQuality: "Indoor climate",
    },
};

const SEPARATE_TYPES: Record<Quantity, VirtualDeviceType> = {
    temperature: "AirQualityTemperature",
    humidity: "AirQualityHumidity",
    co2: "AirQualityCO2",
    pressure: "AirQualityPressure",
};

/** "70:ee:50:12:34:56" -> "70ee50123456" (free@home native ids allow [a-zA-Z0-9_-] only). */
export function idPart(macAddress: string): string {
    return macAddress.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isExcludedModule(module: Pick<ModuleData, "id" | "name">, excluded: string[]): boolean {
    return excluded.includes(normaliseName(module.name)) || excluded.includes(normaliseName(module.id));
}

/** Values an indoor module (or the base station) measures. */
function indoorQuantities(module: ModuleData): Quantity[] {
    return module.type === "NAMain" ? ["temperature", "humidity", "co2", "pressure"] : ["temperature", "humidity", "co2"];
}

/** Determines the free@home devices for the stations of the account. */
export function planDevices(stations: StationData[], settings: PlanSettings): PlannedDevice[] {
    const names = NAMES[settings.nameLanguage];
    const planned: PlannedDevice[] = [];
    for (const station of stations) {
        if (settings.excluded.includes(normaliseName(station.name)))
            continue;
        if (settings.weatherStation) {
            planned.push({
                nativeId: `netatmo-ws-${idPart(station.id)}`,
                name: `${names.weatherStation} ${station.name}`,
                type: "WeatherStation",
                stationId: station.id,
                quantities: [],
            });
        }
        for (const module of [station.main, ...station.modules]) {
            if (isExcludedModule(module, settings.excluded))
                continue;
            const base = `netatmo-${idPart(module.id)}`;
            if (module.type === "NAModule1" && settings.outdoorHumidity) {
                planned.push({
                    nativeId: `${base}-humidity`,
                    name: `${module.name} ${names.humidity}`,
                    type: "AirQualityHumidity",
                    stationId: station.id,
                    moduleId: module.id,
                    quantities: ["humidity"],
                });
            }
            if ((module.type !== "NAMain" && module.type !== "NAModule4") || settings.indoorSensors === "off")
                continue;
            const quantities = indoorQuantities(module);
            if (settings.indoorSensors === "combined") {
                planned.push({
                    nativeId: `${base}-air`,
                    name: `${module.name} ${names.airQuality}`,
                    type: "AirQualityFull",
                    stationId: station.id,
                    moduleId: module.id,
                    quantities,
                });
                continue;
            }
            for (const quantity of quantities) {
                planned.push({
                    nativeId: `${base}-${quantity}`,
                    name: `${module.name} ${names[quantity]}`,
                    type: SEPARATE_TYPES[quantity],
                    stationId: station.id,
                    moduleId: module.id,
                    quantities: [quantity],
                });
            }
        }
    }
    return planned;
}
