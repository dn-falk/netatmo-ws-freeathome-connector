# Netatmo-Weather-Connector for free@home (unofficial)

**English** | [Deutsch](README.de.md)

free@home addon for the **System Access Point 2.0** that shows a **Netatmo Smart Home Weather
Station** in free@home: the outdoor values as a regular **free@home weather station** (brightness,
rain, temperature, wind) and the base station and indoor modules as **sensors** for temperature,
humidity, CO2 and air pressure.

> **Unofficial project:** This addon is a private community project. It is not developed, reviewed,
> supported or endorsed by Netatmo, Legrand or ABB/Busch-Jaeger and is not affiliated with these
> companies. The brand names are only used to describe which products the addon works with. See
> [License and legal notes](#license-and-legal-notes).

- **Complete weather station:** Values your station cannot measure are filled in automatically:
  rain and wind from nearby stations of the **public Netatmo weather map**, brightness from the
  solar radiation of a **weather service**.
- **Alarms as with the original:** frost, wind and brightness alarm with the thresholds set in
  free@home, rain alarm. Blinds, awnings and windows can be linked as usual.
- **Indoor climate:** base station and additional indoor modules as free@home sensors (temperature,
  humidity, CO2, air pressure).
- **Up to date:** the station sends its values to the Netatmo cloud every 10 minutes; the addon
  fetches them about 30 seconds later.
- **Configured entirely in the addon settings** of the free@home app or the SysAP web interface. No
  Node-RED and no manually created virtual devices needed.

## What appears in free@home

| free@home device | Values | Source |
|---|---|---|
| **Weather station** "Wetterstation &lt;station&gt;" (one per Netatmo station) | Outdoor temperature (°C) and frost alarm | Outdoor module; without one: median of the 5 nearest stations of the weather map |
| | Rain alarm | Rain gauge; without one: nearest rain gauges of the weather map |
| | Wind speed (m/s), wind force (Beaufort) and wind alarm | Wind gauge; without one: median of the 3 nearest wind gauges of the weather map |
| | Brightness (lx) and brightness alarm | Weather service (see [Brightness](#brightness)) |
| **Air quality sensors** per indoor module (base station and additional modules) | Temperature, humidity, CO2, air pressure (base station only) | the module |
| **Humidity sensor** of the outdoor module | Outdoor humidity (the free@home weather station has none) | Outdoor module |

The indoor modules appear either as **one sensor per value** (default, e.g. "Kitchen Temperature",
"Kitchen CO2") or as **one combined air quality sensor per module** (setting "Indoor modules").
Alarms (frost, wind and brightness; CO2 and humidity where the free@home device offers them) use the
thresholds you set for the channel in free@home.

### Missing modules: the public Netatmo weather map

Many Netatmo stations share their values publicly (weather map at weathermap.netatmo.com). If your
station has no rain or wind gauge, or a module does not send values for 30 minutes, the addon uses
the stations of the map within the configured radius (default 5 km) around your station:

- **Rain:** the five nearest rain gauges with current values. Rain is reported when at least
  2 of them (setting, fewer if there are fewer gauges) measured rain in their last interval. This
  protects against single faulty stations (e.g. a gauge next to a lawn sprinkler).
- **Wind:** median of the three nearest wind gauges.
- **Temperature:** median of the five nearest stations (only if you have no outdoor module or it
  is not sending).

The rain alarm stays on for 20 minutes after the last measured rain (setting), because rain gauges
report light rain only every now and then. The status line "Current data sources" in the addon
settings shows at any time where the values come from.

### Brightness

Netatmo has no light sensor. The addon therefore takes the **global solar radiation** (W/m²) of a
weather service and converts it into illuminance (about 120 lx per W/m²):

| Setting | Source |
|---|---|
| **Open-Meteo** (default) | Modelled solar radiation of the current 15 minutes, worldwide, free, no registration (in Central Europe based on the DWD ICON-D2 model) |
| **DWD via Bright Sky** | Solar radiation **measured** at the nearest station of the German weather service (Germany only; the nearest station with this measurement may be some distance away) |
| **Calculated from the position of the sun** | No internet service, cloudless sky assumed; useful for twilight, too bright on cloudy days |
| Off | no brightness |

Between two queries the addon follows the position of the sun every minute (the cloudiness of the
last query is applied to the current position of the sun), and in the twilight it uses typical
twilight values. If the weather service cannot be reached for 45 minutes, the cloudless sky is
assumed until it answers again.

> The value is an **approximation for a horizontal surface** and not a measurement at your house.
> It is well suited for twilight and "sunny/not sunny"; for a façade-specific sun protection, choose
> the thresholds with some margin.

## Requirements

- free@home **System Access Point 2.0** with firmware **3.0 or later**, with internet access
- In the free@home next app: **More → Installation settings → Local API** enabled
- **Netatmo Smart Home Weather Station** (base station, optionally outdoor, indoor, rain and wind
  modules) and the Netatmo account it is registered with

## Installation

### 1. Create a Netatmo app and a token

Netatmo only allows access to your station through an "app" that you create yourself in your
account (free of charge):

1. Log in at [dev.netatmo.com](https://dev.netatmo.com) with your **Netatmo account**.
2. **My apps → Create**: enter a name (e.g. "free@home"), a description and your name/e-mail as
   data protection contact, accept the terms and save.
3. The page of the app shows the **client ID** and the **client secret**.
4. Further down, in the **Token generator**, select the scope **`read_station`** and click
   **Generate Token**. Confirm the access on the Netatmo page. Copy the **refresh token**.

Use a separate Netatmo app for the addon (not the one of an existing Node-RED flow): the limits of
the Netatmo API apply per app.

### 2. Download the addon archive

The installable archive is a `.tar` file. Download `netatmo-weather-connector-<version>.tar` from
the [latest release](https://github.com/dn-falk/netatmo-ws-freeathome-connector/releases/latest).

To build it yourself instead (Node.js 18 or later):

```bash
npm ci
npm run pack
```

### 3. Upload the addon

- **free@home next app:** More → Installation settings → Addons → **Upload**, then select the
  `.tar` file.
- or through the **web interface** of the System Access Point
- or from the command line:
  `FREEATHOME_BASE_URL=http://<SysAP-IP> FREEATHOME_API_USERNAME=<user> FREEATHOME_API_PASSWORD=<password> npx free-at-home-cli upload`

The addon then appears in the addon list as **"Netatmo-Weather-Connector (unofficial)"** and must
be shown as **active**.

### 4. Settings

| Setting | Meaning |
|---|---|
| **Client ID**, **Client secret** | from the page of your app on dev.netatmo.com |
| **Refresh token** | from the Token generator (scope `read_station`) |
| Indoor modules | one sensor per value (default) · one air quality sensor per module · do not create |
| Outdoor humidity sensor | humidity sensor for the outdoor module (default on) |
| Excluded modules | comma-separated names from the Netatmo app of modules that should not be created; the name of a station excludes the whole station |
| Language of new device names | German (default) or English suffixes, e.g. "Küche Temperatur" |
| Outdoor temperature, Rain, Wind | **Automatic** (own module, otherwise weather map; default) · own module only · weather map · off |
| Brightness | Open-Meteo (default) · DWD via Bright Sky · calculated from the position of the sun · off |
| Wind speed | **gusts** (default, recommended for the wind alarm) or average |
| Keep rain alarm for | minutes after the last measured rain (default 20) |
| Radius for the weather map | km around the station (default 5) |
| Rain: required public rain gauges | how many of the nearest five gauges must measure rain (default 2) |
| Latitude/Longitude (optional) | location for weather map and brightness; empty: location of the Netatmo station |
| Maximum update interval | the addon fetches the values shortly after every upload of the station, at the latest after this time (default 10 min) |
| Debug logging | detailed messages in the log, e.g. every value sent to free@home and the stations used from the weather map |

After saving, the addon connects. **Status** shows e.g. "Connected, 1 station(s), 9 free@home
device(s)", **Current data sources** e.g. "Temperature outdoor module · Rain weather map (0/5 gauges
with rain) · Wind weather map (3 stations) · Brightness 23500 lx Open-Meteo". **Reload stations**
reads the station at once, e.g. after adding a module in the Netatmo app.

**The refresh token is renewed automatically.** Netatmo issues a new refresh token every few hours
and invalidates the previous one. The addon stores the current token itself in its configuration
(hidden field "Stored token"), so it keeps working after a restart. The token you entered stays
visible unchanged; only enter a new one if the status asks for it.

### 5. Use in free@home

- The devices appear in the device list, named after the Netatmo station and modules. Assign them to
  a room and rename them if needed, as usual.
- **Weather station:** set the thresholds for frost, wind and brightness alarm in the settings of the
  channels and link blinds, awnings or windows with the weather station as with the original.
- **Sensors:** temperature, humidity, CO2 and air pressure are shown in the app and can be used in
  actions/automations.

The free@home device IDs are derived from the MAC address of the Netatmo module
(`netatmo-<mac>-<value>`, weather station `netatmo-ws-<mac of the base station>`). Changing the
settings or reinstalling the addon keeps the devices and links in free@home. After switching
"Indoor modules" between separate and combined sensors, the devices that are no longer used are shown
as "not reachable"; delete them in free@home.

**Coming from Node-RED:** stop the Node-RED flow, delete the virtual devices it created in free@home
and link the actuators with the devices of the addon.

## Troubleshooting

| Status / symptom | Cause and solution |
|---|---|
| "Configuration needed: …" | Client ID, client secret or refresh token missing, or invalid coordinates. |
| "Netatmo rejects the token …" | The token was revoked (e.g. new token generated elsewhere, app deleted) or client ID/secret are wrong. Generate a new refresh token in the Token generator and enter it. |
| "The token lacks the scope read_station …" | Generate the token again with the scope `read_station` ticked. |
| "Too many requests to Netatmo …" | Netatmo allows 500 requests per hour per app and user. The addon needs about 20–30 per hour; use a separate Netatmo app for the addon. The addon waits 15 minutes and tries again. |
| "Netatmo not reachable" | No internet connection of the SysAP or Netatmo disturbance. The addon keeps trying; sensors whose values are older than 30 minutes are shown as "not reachable". |
| Current data sources "Rain no data" | No rain gauge of your own and no public rain gauge within the radius: increase the radius. |
| Brightness "calculated (weather service not available)" | Open-Meteo/Bright Sky not reachable, or (Bright Sky) no DWD station with radiation measurement nearby: choose Open-Meteo. |
| Sensor "not reachable" | The Netatmo module has not sent values for 30 minutes (battery, radio range). The Netatmo app shows the same. The log warns when a module battery drops below 20 %. |
| "Log" tab in the addon settings stays empty | **Download** there provides the complete log as a file. |

The addon writes its messages to the SysAP journal. In the addon settings, **Log → Download** saves
them as a file; with the `FREEATHOME_*` variables set, `npm run journal` shows them. For details,
turn on **Debug logging** in the settings.

## Limitations

- **Delay:** the station sends its values every 10 minutes, the public stations too. A rain alarm
  therefore comes up to about 10 minutes later than with a heated rain sensor. For awnings that must
  retract at the first drop, a dedicated rain sensor remains the safer choice.
- **Brightness** is an approximation from weather service data, see [Brightness](#brightness).
- Values free@home has no datapoint for are not transferred: noise level, rain amounts (mm), wind
  direction, minimum/maximum temperatures.
- Only the Netatmo **Weather Station** (NAMain with modules NAModule1–4) is supported, not the Healthy
  Home Coach or other Netatmo products. Stations you only follow as favourites are not used.
- The free@home device types of the local API are documented only briefly. The addon writes only to
  datapoints the SysAP actually reports for the device.
- Tested with unit and integration tests against a simulated Netatmo cloud and a simulated System
  Access Point, both with the real free@home library. Memory use is about the same as that of the
  [Somfy-TaHoma-Connector](https://github.com/dn-falk/somfy-freeathome-connector) (SysAP limit 64 MB
  per addon).

## Development

```bash
npm ci
npm test            # unit and integration tests (Netatmo simulator, fake SysAP, real free@home library)
npm run build       # TypeScript -> build/
npm run pack        # installable addon archive (.tar)
```

**Running the addon on a PC against your own SysAP.** The addon must not run on the SysAP at the
same time, otherwise devices are duplicated.

```bash
export FREEATHOME_BASE_URL=http://<SysAP-IP>
export FREEATHOME_API_USERNAME=<Local API user>
export FREEATHOME_API_PASSWORD=<password>
npm run build && npm start
```

**Without a Netatmo account:** `npm run mock -- --port 18080 --rain 0.2` starts a simulated Netatmo
cloud (station "Zuhause" with outdoor and indoor module, public stations with rain and wind) and
weather service. Then start the addon with
`NETATMO_API_URL=http://localhost:18080 OPEN_METEO_URL=http://localhost:18080 BRIGHT_SKY_URL=http://localhost:18080 npm start`
and enter client ID `client-id`, client secret `client-secret` and refresh token `refresh-0`.

### Releases

Releases are created by GitHub Actions. When `main` contains a version that has not been released
yet, CI runs the tests, builds the archive and publishes the release `v<version>` with the file
`netatmo-weather-connector-<version>.tar`. To publish a new version, increase the version on a
branch and merge it into `main`:

```bash
npm version 1.1.0 --no-git-tag-version   # package.json and package-lock.json
# and set the same "version" in free-at-home-metadata.json
```

### Structure

```
src/
  main.ts                  entry point: free@home library, addon configuration, RPC, signals
  app.ts                   (re)starts the connection on configuration changes, stores the refresh token, status
  config.ts                reads and checks the settings from the addon UI
  status.ts                status display (settings, application state)
  bridge/bridge.ts         query cycle: Netatmo, weather map, brightness -> free@home devices
  bridge/plan.ts           which free@home devices exist for the stations and settings
  bridge/weather.ts        values of the weather station incl. fallback to the weather map and rain hold time
  fah/                     virtual free@home devices, datapoints and alarms, device registry
  netatmo/                 Netatmo API client, token renewal, station and weather map data
  weather/                 brightness: weather services, position of the sun, twilight
test/                      tests incl. Netatmo simulator and fake System Access Point
tools/mock-netatmo.ts      simulated Netatmo cloud for development
```

## License and legal notes

- **Not an official product:** This addon is an independent community project. It is not a product
  of Netatmo, Legrand or ABB/Busch-Jaeger. These companies did not commission, review, certify or
  approve it, and they do not provide support for it.
- **Support:** Please report questions and bugs through the
  [issues](https://github.com/dn-falk/netatmo-ws-freeathome-connector/issues) of this repository,
  not to Netatmo or Busch-Jaeger support.
- **Trademarks:** Netatmo, Legrand, free@home, Busch-free@home, Busch-Jaeger and ABB are trademarks or
  registered trademarks of their respective owners. They are only used here to describe which
  products the addon works with. This implies no affiliation with the trademark owners and no
  endorsement by them. No manufacturer logos are used.
- **Interfaces and data:** The addon only uses officially documented interfaces: the Netatmo Connect
  Weather API with your own app and token, the Local API and addon interface of the free@home System
  Access Point, and the public APIs of the weather services.
  Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Source of the DWD data:
  Deutscher Wetterdienst, via [Bright Sky](https://brightsky.dev/).
- **License and liability:** MIT license, see [LICENSE](LICENSE). The software is provided without
  any warranty; use at your own risk. The weather station values of the addon must not be relied on
  for the protection of people or property.
