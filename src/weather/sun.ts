import { Location } from "../netatmo/stations";

const RAD = Math.PI / 180;

/**
 * Elevation of the sun above the horizon in degrees (without refraction), after the
 * low-precision formulas of the Astronomical Almanac (accurate to about 0.01°).
 */
export function solarElevation(time: number, location: Location): number {
    const days = time / 86_400_000 + 2_440_587.5 - 2_451_545.0;
    const meanAnomaly = (357.529 + 0.98560028 * days) * RAD;
    const meanLongitude = 280.459 + 0.98564736 * days;
    const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * RAD;
    const obliquity = (23.439 - 0.00000036 * days) * RAD;

    const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
    const siderealHours = 18.697374558 + 24.06570982441908 * days;
    const hourAngle = (siderealHours * 15 + location.longitude) * RAD - rightAscension;

    const latitude = location.latitude * RAD;
    const sinElevation = Math.sin(latitude) * Math.sin(declination)
        + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
    return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
}

/** Global horizontal irradiance (W/m²) for a cloudless sky after Haurwitz (1945). */
export function clearSkyIrradiance(elevation: number): number {
    const cosZenith = Math.sin(elevation * RAD);
    if (cosZenith <= 0)
        return 0;
    return 1098 * cosZenith * Math.exp(-0.059 / cosZenith);
}

/** Luminous efficacy of daylight: illuminance (lx) per irradiance (W/m²). */
export const LUX_PER_WATT = 120;

/** Typical illuminance (lx) at a sun elevation in the twilight, log-linear between the points. */
const TWILIGHT: readonly [number, number][] = [
    [-12, 0.01],
    [-6, 3],
    [0, 400],
    [5, 2000],
];

/**
 * Illuminance in the twilight (cloudless sky). The irradiance model above reaches 0 at the
 * horizon, while it is still several hundred lux bright then.
 */
export function twilightIlluminance(elevation: number): number {
    if (elevation < TWILIGHT[0][0])
        return 0;
    for (let i = 1; i < TWILIGHT.length; i++) {
        const [e0, l0] = TWILIGHT[i - 1];
        const [e1, l1] = TWILIGHT[i];
        if (elevation <= e1) {
            const fraction = (elevation - e0) / (e1 - e0);
            return Math.exp(Math.log(l0) + fraction * (Math.log(l1) - Math.log(l0)));
        }
    }
    return TWILIGHT[TWILIGHT.length - 1][1];
}

/** Illuminance (lx) of a cloudless sky at the given time and place. */
export function clearSkyIlluminance(time: number, location: Location): number {
    const elevation = solarElevation(time, location);
    return Math.max(clearSkyIrradiance(elevation) * LUX_PER_WATT, twilightIlluminance(elevation));
}
