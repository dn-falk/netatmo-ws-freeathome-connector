/**
 * Responses of the Netatmo Weather API (only the fields the addon uses). All values are
 * metric: °C, %, ppm, mbar (= hPa), km/h, mm; times are Unix seconds.
 */

export interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
}

export interface Place {
    /** [longitude, latitude] */
    location?: number[];
    altitude?: number;
    city?: string;
    timezone?: string;
}

export interface DashboardData {
    time_utc?: number;
    Temperature?: number;
    Humidity?: number;
    CO2?: number;
    Noise?: number;
    /**
     * Pressure reduced to sea level (mbar), as shown in the Netatmo app. The current API
     * specification swaps the descriptions of Pressure and AbsolutePressure, but real responses
     * are unambiguous: a station at 664 m reports Pressure 1017.3 and AbsolutePressure 939.7.
     */
    Pressure?: number;
    /** Pressure at the altitude of the station (mbar). */
    AbsolutePressure?: number;
    WindStrength?: number;
    WindAngle?: number;
    GustStrength?: number;
    GustAngle?: number;
    /** Rain since the previous measurement (mm). */
    Rain?: number;
    sum_rain_1?: number;
    sum_rain_24?: number;
}

export interface RawModule {
    _id?: string;
    type?: string;
    module_name?: string;
    reachable?: boolean;
    last_seen?: number;
    battery_percent?: number;
    data_type?: string[];
    dashboard_data?: DashboardData;
}

export interface RawStation extends RawModule {
    station_name?: string;
    home_name?: string;
    place?: Place;
    /** True for stations the user only follows (favourites) or that were shared read-only. */
    read_only?: boolean;
    favorite?: boolean;
    modules?: RawModule[];
}

export interface StationsDataBody {
    devices?: RawStation[];
}

export interface PublicMeasure {
    /** {"<unix time>": [values in the order of `type`]} */
    res?: Record<string, number[]>;
    type?: string[];
    rain_60min?: number;
    rain_24h?: number;
    rain_live?: number;
    rain_timeutc?: number;
    rain_utc?: number;
    wind_strength?: number;
    wind_angle?: number;
    gust_strength?: number;
    /** Spelling of the API specification ("wind_strengh", "gust_strenght"); the API sends the above. */
    wind_strengh?: number;
    gust_strenght?: number;
    gust_angle?: number;
    wind_timeutc?: number;
}

export interface RawPublicStation {
    _id?: string;
    place?: Place;
    measures?: Record<string, PublicMeasure>;
}

export type PublicDataKind = "temperature" | "rain" | "wind";

/** Area for /getpublicdata. */
export interface BoundingBox {
    latNE: number;
    lonNE: number;
    latSW: number;
    lonSW: number;
}
