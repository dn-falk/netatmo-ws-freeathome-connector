/**
 * Pairing IDs of the outputs the addon writes. The values are the same as in `PairingIds` of
 * `@busch-jaeger/free-at-home` (checked by a unit test); they are repeated here so the logic can
 * be tested without the library.
 */
export const PairingId = {
    /** Weather station, wind channel: wind alarm (0/1). */
    AL_WIND_ALARM: 0x0025,
    /** Weather station, temperature channel: frost alarm (0/1). */
    AL_FROST_ALARM: 0x0026,
    /** Weather station, rain channel: rain alarm (0/1). */
    AL_RAIN_ALARM: 0x0027,
    /** Air quality sensor: temperature (°C). */
    AL_MEASURED_TEMPERATURE: 0x0130,
    /** Air quality sensor: relative humidity (%). */
    AL_HUMIDITY: 0x0151,
    /** Weather station, temperature channel: outdoor temperature (°C). */
    AL_OUTDOOR_TEMPERATURE: 0x0400,
    /** Weather station, wind channel: wind force (Beaufort 0…12). */
    AL_WIND_FORCE: 0x0401,
    /** Weather station, brightness channel: brightness alarm (0/1). */
    AL_BRIGHTNESS_ALARM: 0x0402,
    /** Weather station, brightness channel: brightness (lx). */
    AL_BRIGHTNESS_LEVEL: 0x0403,
    /** Weather station, wind channel: wind speed (m/s). */
    AL_WIND_SPEED: 0x0404,
    /** Air quality sensor: air pressure (hPa). */
    AL_INFO_PRESSURE: 0x061A,
    /** Air quality sensor: CO2 (ppm). */
    AL_INFO_CO_2: 0x061B,
    /** Air quality sensor: CO2 above the alert level (0/1). */
    AL_CO2_ALERT: 0x0628,
    /** Air quality sensor: humidity outside the alert limits (0/1). */
    AL_HUMIDITY_ALERT: 0x062A,
} as const;

/** Channel parameters set in the free@home app (same values as `ParameterIds` of the library). */
export const ParameterId = {
    /** Brightness alarm at or above this brightness (lx). */
    PID_BRIGHTNESS_ALERT_ACTIVATION_LEVEL: 0x002B,
    /** Frost alarm at or below this temperature (°C). */
    PID_FROST_ALARM_ACTIVATION_LEVEL: 0x002D,
    /** Wind alarm at or above this wind force (Beaufort). */
    PID_WIND_FORCE: 0x002E,
    /** CO2 alert at or above this level (ppm). */
    PID_CO2_ALERT_ACTIVATION_LEVEL: 0x0170,
    PID_HUMIDITY_ALERT_LOWER_LIMIT: 0x0174,
    PID_HUMIDITY_ALERT_UPPER_LIMIT: 0x0175,
    /** CO2 alert enabled ("0" = off). */
    PID_ENABLE_CO2_ALERT: 0x0176,
} as const;

/** Lower limits (m/s) of Beaufort 1 to 12. */
const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];

export function beaufort(speedMs: number): number {
    let force = 0;
    while (force < BEAUFORT_LIMITS.length && speedMs >= BEAUFORT_LIMITS[force])
        force++;
    return force;
}

export function kmhToMs(kmh: number): number {
    return kmh / 3.6;
}

/** Values the addon shows in free@home (units as expected by free@home). */
export interface SensorValues {
    /** °C (weather station) */
    outdoorTemperature?: number;
    /** m/s (weather station) */
    windSpeed?: number;
    /** weather station */
    raining?: boolean;
    /** lx (weather station) */
    brightness?: number;
    /** °C (air quality sensor) */
    temperature?: number;
    /** % */
    humidity?: number;
    /** ppm */
    co2?: number;
    /** hPa */
    pressure?: number;
}

type Parameters = ReadonlyMap<number, string>;

function numberParameter(parameters: Parameters, id: number): number | undefined {
    const text = parameters.get(id);
    if (text === undefined || text.trim() === "")
        return undefined;
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? value : undefined;
}

const flag = (value: boolean) => value ? "1" : "0";
const fixed = (digits: number) => (value: number) => String(Number(value.toFixed(digits)));

interface OutputRule {
    id: number;
    /** Datapoint value, or undefined if nothing is to be written (value or parameter missing). */
    value(values: SensorValues, parameters: Parameters): string | undefined;
}

function measured(id: number, key: keyof SensorValues, format: (value: number) => string): OutputRule {
    return {
        id,
        value: (values) => {
            const value = values[key];
            return typeof value === "number" && Number.isFinite(value) ? format(value) : undefined;
        },
    };
}

/**
 * How each output datapoint is derived from the values and the channel parameters. Alarms
 * follow the virtual weather channels of the free@home library: they are only written once
 * the threshold is known from the channel parameters.
 */
export const OUTPUT_RULES: readonly OutputRule[] = [
    measured(PairingId.AL_OUTDOOR_TEMPERATURE, "outdoorTemperature", fixed(1)),
    {
        id: PairingId.AL_FROST_ALARM,
        value: (values, parameters) => {
            const level = numberParameter(parameters, ParameterId.PID_FROST_ALARM_ACTIVATION_LEVEL);
            return values.outdoorTemperature === undefined || level === undefined ? undefined : flag(values.outdoorTemperature <= level);
        },
    },
    measured(PairingId.AL_WIND_SPEED, "windSpeed", fixed(1)),
    measured(PairingId.AL_WIND_FORCE, "windSpeed", (speed) => String(beaufort(speed))),
    {
        id: PairingId.AL_WIND_ALARM,
        value: (values, parameters) => {
            const level = numberParameter(parameters, ParameterId.PID_WIND_FORCE);
            return values.windSpeed === undefined || level === undefined ? undefined : flag(beaufort(values.windSpeed) >= level);
        },
    },
    {
        id: PairingId.AL_RAIN_ALARM,
        value: (values) => values.raining === undefined ? undefined : flag(values.raining),
    },
    measured(PairingId.AL_BRIGHTNESS_LEVEL, "brightness", fixed(0)),
    {
        id: PairingId.AL_BRIGHTNESS_ALARM,
        value: (values, parameters) => {
            const level = numberParameter(parameters, ParameterId.PID_BRIGHTNESS_ALERT_ACTIVATION_LEVEL);
            return values.brightness === undefined || level === undefined ? undefined : flag(values.brightness >= level);
        },
    },
    measured(PairingId.AL_MEASURED_TEMPERATURE, "temperature", fixed(1)),
    measured(PairingId.AL_HUMIDITY, "humidity", fixed(0)),
    {
        id: PairingId.AL_HUMIDITY_ALERT,
        value: (values, parameters) => {
            const lower = numberParameter(parameters, ParameterId.PID_HUMIDITY_ALERT_LOWER_LIMIT);
            const upper = numberParameter(parameters, ParameterId.PID_HUMIDITY_ALERT_UPPER_LIMIT);
            if (values.humidity === undefined || (lower === undefined && upper === undefined))
                return undefined;
            return flag((lower !== undefined && values.humidity < lower) || (upper !== undefined && values.humidity > upper));
        },
    },
    measured(PairingId.AL_INFO_CO_2, "co2", fixed(0)),
    {
        id: PairingId.AL_CO2_ALERT,
        value: (values, parameters) => {
            const level = numberParameter(parameters, ParameterId.PID_CO2_ALERT_ACTIVATION_LEVEL);
            if (values.co2 === undefined || level === undefined)
                return undefined;
            const enabled = parameters.get(ParameterId.PID_ENABLE_CO2_ALERT) !== "0";
            return flag(enabled && values.co2 >= level);
        },
    },
    measured(PairingId.AL_INFO_PRESSURE, "pressure", fixed(1)),
];
