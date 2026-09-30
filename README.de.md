# Netatmo-Wetter-Connector für free@home (inoffiziell)

[English](README.md) | **Deutsch**

free@home-Addon für den **System Access Point 2.0**, das eine **Netatmo Smarte Wetterstation** in
free@home anzeigt: die Außenwerte als normale **free@home-Wetterstation** (Helligkeit, Regen,
Temperatur, Wind) und die Basisstation und Innenmodule als **Sensoren** für Temperatur,
Luftfeuchte, CO2 und Luftdruck.

> **Inoffizielles Projekt:** Dieses Addon ist ein privates Community-Projekt. Es wird weder von
> Netatmo, Legrand noch ABB/Busch-Jaeger entwickelt, geprüft, unterstützt oder empfohlen und steht in
> keiner Verbindung zu diesen Unternehmen. Die Markennamen werden nur genannt, um zu beschreiben, mit
> welchen Produkten das Addon zusammenarbeitet. Details unter
> [Lizenz und rechtliche Hinweise](#lizenz-und-rechtliche-hinweise).

- **Vollständige Wetterstation:** Werte, die die eigene Station nicht misst, werden automatisch
  ergänzt: Regen und Wind von Stationen der **öffentlichen Netatmo-Wetterkarte** in der Nähe, die
  Helligkeit aus der Sonneneinstrahlung eines **Wetterdienstes**.
- **Alarme wie beim Original:** Frost-, Wind- und Helligkeitsalarm mit den in free@home eingestellten
  Schwellen, Regenalarm. Rollläden, Markisen und Fenster lassen sich wie gewohnt verknüpfen.
- **Raumklima:** Basisstation und zusätzliche Innenmodule als free@home-Sensoren (Temperatur,
  Luftfeuchte, CO2, Luftdruck).
- **Aktuell:** Die Station überträgt ihre Werte alle 10 Minuten an die Netatmo-Cloud; das Addon holt
  sie etwa 30 Sekunden danach ab.
- **Konfiguration komplett in der Addon-Oberfläche** der free@home-App bzw. der SysAP-Weboberfläche.
  Kein Node-RED und keine manuell angelegten virtuellen Geräte nötig.

## Was in free@home erscheint

| free@home-Gerät | Werte | Quelle |
|---|---|---|
| **Wetterstation** „Wetterstation &lt;Station&gt;“ (eine pro Netatmo-Station) | Außentemperatur (°C) und Frostalarm | Außenmodul; ohne: Median der 5 nächsten Stationen der Wetterkarte |
| | Regenalarm | Regenmesser; ohne: nächste Regenmesser der Wetterkarte |
| | Windgeschwindigkeit (m/s), Windstärke (Beaufort) und Windalarm | Windmesser; ohne: Median der 3 nächsten Windmesser der Wetterkarte |
| | Helligkeit (lx) und Helligkeitsalarm | Wetterdienst (siehe [Helligkeit](#helligkeit)) |
| **Luftqualitätssensoren** pro Innenmodul (Basisstation und Zusatzmodule) | Temperatur, Luftfeuchte, CO2, Luftdruck (nur Basisstation) | das Modul |
| **Luftfeuchtesensor** des Außenmoduls | Außen-Luftfeuchte (die free@home-Wetterstation hat keine) | Außenmodul |

Die Innenmodule erscheinen entweder als **ein Sensor pro Messwert** (Standard, z. B. „Küche
Temperatur“, „Küche CO2“) oder als **ein kombinierter Luftqualitätssensor pro Modul** (Einstellung
„Innenmodule“). Alarme (Frost, Wind und Helligkeit; CO2 und Luftfeuchte, wo das free@home-Gerät sie
anbietet) verwenden die Schwellen, die in free@home für den Kanal eingestellt sind.

### Fehlende Module: die öffentliche Netatmo-Wetterkarte

Viele Netatmo-Stationen teilen ihre Werte öffentlich (Wetterkarte auf weathermap.netatmo.com). Hat
die eigene Station keinen Regen- oder Windmesser, oder sendet ein Modul 30 Minuten lang keine Werte,
nutzt das Addon die Stationen der Karte im eingestellten Umkreis (Standard 5 km) um die eigene
Station:

- **Regen:** die fünf nächsten Regenmesser mit aktuellen Werten. Regen wird gemeldet, wenn
  mindestens 2 davon (Einstellung, weniger, wenn es weniger Messer gibt) im letzten Intervall Regen
  gemessen haben. Das schützt vor einzelnen fehlerhaften Stationen (z. B. ein Messer neben dem
  Rasensprenger).
- **Wind:** Median der drei nächsten Windmesser.
- **Temperatur:** Median der fünf nächsten Stationen (nur, wenn es kein Außenmodul gibt oder es nicht
  sendet).

Der Regenalarm bleibt nach dem zuletzt gemessenen Regen 20 Minuten aktiv (Einstellung), weil
Regenmesser leichten Regen nur ab und zu melden. Die Statuszeile „Aktuelle Datenquellen“ in den
Addon-Einstellungen zeigt jederzeit, woher die Werte kommen; die Einstellungen erklären das
Verhalten direkt am jeweiligen Feld.

### Helligkeit

Netatmo hat keinen Lichtsensor. Das Addon nimmt deshalb die **Globalstrahlung** (W/m²) eines
Wetterdienstes und rechnet sie in Beleuchtungsstärke um (etwa 120 lx pro W/m²):

| Einstellung | Quelle |
|---|---|
| **Open-Meteo** (Standard) | Modellierte Sonneneinstrahlung der aktuellen 15 Minuten, weltweit, kostenlos, ohne Anmeldung (in Mitteleuropa auf Basis des DWD-Modells ICON-D2) |
| **DWD über Bright Sky** | An der nächsten Station des Deutschen Wetterdienstes **gemessene** Sonneneinstrahlung (nur Deutschland; die nächste Station mit dieser Messung kann etwas entfernt sein) |
| **Aus dem Sonnenstand berechnet** | Ohne Internetdienst, wolkenloser Himmel angenommen; brauchbar für die Dämmerung, an bewölkten Tagen zu hell |
| Aus | keine Helligkeit |

Zwischen zwei Abfragen führt das Addon den Wert jede Minute mit dem Sonnenstand nach (die Bewölkung
der letzten Abfrage wird auf den aktuellen Sonnenstand übertragen), in der Dämmerung verwendet es
typische Dämmerungswerte. Ist der letzte Wert des Wetterdienstes älter als 45 Minuten (Dienst nicht
erreichbar), wird bis zum nächsten Wert wolkenloser Himmel angenommen.

> Der Wert ist ein **Näherungswert für eine waagerechte Fläche** und keine Messung am eigenen Haus.
> Er eignet sich gut für Dämmerung und „sonnig/nicht sonnig“; für einen fassadengenauen Sonnenschutz
> die Schwellen mit etwas Reserve wählen.

## Voraussetzungen

- free@home **System Access Point 2.0** mit Firmware **3.0 oder neuer**, mit Internetzugang
- In der free@home-next-App: **Mehr → Installationseinstellungen → Local API** aktiviert
- **Netatmo Smarte Wetterstation** (Basisstation, optional Außen-, Innen-, Regen- und Windmodul) und
  das Netatmo-Konto, auf das sie angemeldet ist

## Installation

### 1. Netatmo-App und Token anlegen

Netatmo erlaubt den Zugriff auf die eigene Station nur über eine „App“, die man im eigenen Konto
selbst anlegt (kostenlos):

1. Auf [dev.netatmo.com](https://dev.netatmo.com) mit dem **Netatmo-Konto** anmelden.
2. **My apps → Create**: einen Namen (z. B. „free@home“), eine Beschreibung und den eigenen
   Namen/die eigene E-Mail als Datenschutz-Kontakt eintragen, den Bedingungen zustimmen und
   speichern.
3. Die Seite der App zeigt **Client ID** und **Client Secret**.
4. Weiter unten im **Token generator** den Scope **`read_station`** auswählen und **Generate Token**
   klicken. Den Zugriff auf der Netatmo-Seite bestätigen. Den **Refresh Token** kopieren.

Für das Addon eine eigene Netatmo-App verwenden (nicht die eines bestehenden Node-RED-Flows): Die
Grenzen der Netatmo-API gelten pro App.

### 2. Addon-Archiv herunterladen

Das installierbare Archiv ist eine `.tar`-Datei. `netatmo-weather-connector-<version>.tar` aus dem
[neuesten Release](https://github.com/dn-falk/netatmo-ws-freeathome-connector/releases/latest)
herunterladen.

Oder selbst bauen (Node.js 18 oder neuer):

```bash
npm ci
npm run pack
```

### 3. Addon hochladen

- **free@home-next-App:** Mehr → Installationseinstellungen → Addons → **Hochladen** und die
  `.tar`-Datei auswählen.
- oder über die **Weboberfläche** des System Access Point
- oder per Kommandozeile:
  `FREEATHOME_BASE_URL=http://<SysAP-IP> FREEATHOME_API_USERNAME=<Benutzer> FREEATHOME_API_PASSWORD=<Passwort> npx free-at-home-cli upload`

Das Addon erscheint danach in der Addon-Liste als **„Netatmo-Wetter-Connector (inoffiziell)“** und
muss als **aktiv** angezeigt werden.

### 4. Einstellungen

| Einstellung | Bedeutung |
|---|---|
| **Client ID**, **Client Secret** | von der Seite der eigenen App auf dev.netatmo.com |
| **Refresh Token** | aus dem Token generator (Scope `read_station`) |
| Innenmodule | ein Sensor pro Messwert (Standard) · ein Luftqualitätssensor pro Modul · nicht anlegen |
| Sensor für Außen-Luftfeuchte | Luftfeuchtesensor für das Außenmodul (Standard an) |
| Ausgeschlossene Module | kommagetrennte Namen aus der Netatmo-App von Modulen, die nicht angelegt werden sollen; der Name einer Station schließt die ganze Station aus |
| Sprache neuer Gerätenamen | deutsche (Standard) oder englische Zusätze, z. B. „Küche Temperatur“ |
| Außentemperatur, Regen, Wind | **Automatisch** (eigenes Modul, sonst Wetterkarte; Standard) · nur eigenes Modul · Wetterkarte · aus |
| Helligkeit | Open-Meteo (Standard) · DWD über Bright Sky · aus dem Sonnenstand berechnet · aus |
| Windgeschwindigkeit | **Böen** (Standard, empfohlen für den Windalarm) oder Mittelwert |
| Regenalarm halten für | Minuten nach dem zuletzt gemessenen Regen (Standard 20) |
| Umkreis für die Wetterkarte | km um die Station (Standard 5) |
| Regen: nötige öffentliche Regenmesser | wie viele der fünf nächsten Messer Regen messen müssen (Standard 2) |
| Breiten-/Längengrad (optional) | Standort für Wetterkarte und Helligkeit; leer: Standort der Netatmo-Station |
| Maximaler Abfrageabstand | das Addon holt die Werte kurz nach jeder Übertragung der Station ab, spätestens nach dieser Zeit (Standard 10 min) |
| Debug-Protokoll | ausführliche Meldungen im Protokoll, z. B. jeder an free@home gesendete Wert und die verwendeten Stationen der Wetterkarte |

Nach dem Speichern verbindet sich das Addon. **Status** zeigt z. B. „Verbunden, 1 Station(en),
9 free@home-Geräte“, **Aktuelle Datenquellen** z. B. „Temperatur Außenmodul · Regen Wetterkarte
(0/5 Messer mit Regen) · Wind Wetterkarte (3 Stationen) · Helligkeit 23500 lx Open-Meteo“.
**Stationen neu einlesen** liest die Station sofort, z. B. nachdem in der Netatmo-App ein Modul
hinzugefügt wurde.

**Der Refresh Token wird automatisch erneuert.** Netatmo gibt alle paar Stunden einen neuen Refresh
Token aus und macht den vorherigen ungültig. Das Addon speichert den aktuellen Token selbst in seiner
Konfiguration (verstecktes Feld „Gespeicherter Token“) und arbeitet deshalb auch nach einem Neustart
weiter. Der eingetragene Token bleibt unverändert sichtbar; nur neu eintragen, wenn der Status dazu
auffordert.

### 5. In free@home verwenden

- Die Geräte erscheinen in der Geräteliste, benannt nach Netatmo-Station und -Modulen. Wie gewohnt
  einem Raum zuordnen und bei Bedarf umbenennen.
- **Wetterstation:** in den Einstellungen der Kanäle die Schwellen für Frost-, Wind- und
  Helligkeitsalarm einstellen und Rollläden, Markisen oder Fenster wie beim Original mit der
  Wetterstation verknüpfen.
- **Sensoren:** Temperatur, Luftfeuchte, CO2 und Luftdruck werden in der App angezeigt und können in
  Aktionen/Automationen verwendet werden.

Die free@home-Geräte-ID wird aus der MAC-Adresse des Netatmo-Moduls gebildet
(`netatmo-<mac>-<wert>`, Wetterstation `netatmo-ws-<mac der Basisstation>`). Beim Ändern der
Einstellungen oder Neuinstallieren des Addons bleiben Geräte und Verknüpfungen in free@home
erhalten. Nach dem Umschalten der „Innenmodule“ zwischen einzelnen und kombinierten Sensoren werden
die nicht mehr genutzten Geräte als „nicht erreichbar“ angezeigt; diese in free@home löschen.

**Umstieg von Node-RED:** den Node-RED-Flow stoppen, die von ihm angelegten virtuellen Geräte in
free@home löschen und die Aktoren mit den Geräten des Addons verknüpfen.

## Fehlersuche

| Status / Symptom | Ursache und Lösung |
|---|---|
| „Konfiguration nötig: …“ | Client ID, Client Secret oder Refresh Token fehlt, oder ungültige Koordinaten. |
| „Netatmo lehnt den Token ab …“ | Der Token wurde widerrufen (z. B. anderswo neuer Token erzeugt, App gelöscht) oder Client ID/Secret stimmen nicht. Im Token generator einen neuen Refresh Token erzeugen und eintragen. |
| „Dem Token fehlt der Scope read_station …“ | Den Token neu erzeugen und dabei `read_station` anhaken. |
| „Zu viele Anfragen an Netatmo …“ | Netatmo erlaubt 500 Anfragen pro Stunde je App und Benutzer. Das Addon braucht etwa 20–30 pro Stunde; für das Addon eine eigene Netatmo-App verwenden. Das Addon wartet 15 Minuten (länger, wenn Netatmo das verlangt) und versucht es erneut. |
| „Die Netatmo-App wurde deaktiviert …“ | Netatmo hat die eigene App auf dev.netatmo.com deaktiviert. Unter **My apps** wieder aktivieren; das Addon versucht es alle 30 Minuten erneut, sofort mit **Stationen neu einlesen**. |
| „Netatmo nicht erreichbar“ | Keine Internetverbindung des SysAP oder Störung bei Netatmo. Das Addon versucht es weiter; Sensoren, deren Werte älter als 30 Minuten sind, werden als „nicht erreichbar“ angezeigt. |
| Aktuelle Datenquellen „Regen keine Daten“ | Kein eigener Regenmesser und kein öffentlicher Regenmesser im Umkreis: Umkreis vergrößern. |
| Helligkeit „berechnet (Wetterdienst nicht erreichbar)“ | Open-Meteo/Bright Sky nicht erreichbar oder (Bright Sky) keine DWD-Station mit Strahlungsmessung in der Nähe: Open-Meteo wählen. |
| Sensor „nicht erreichbar“ | Das Netatmo-Modul hat seit 30 Minuten keine Werte gesendet (Batterie, Funkreichweite). Die Netatmo-App zeigt dasselbe. Das Protokoll warnt, wenn eine Modulbatterie unter 20 % fällt. |
| Reiter „Log“ in den Addon-Einstellungen bleibt leer | Dort über **Herunterladen** das vollständige Protokoll als Datei holen. |

Das Addon schreibt seine Meldungen in das Journal des SysAP. In den Addon-Einstellungen speichert
**Log → Herunterladen** sie als Datei; mit gesetzten `FREEATHOME_*`-Variablen zeigt `npm run journal`
sie an. Für Details in den Einstellungen das **Debug-Protokoll** einschalten.

## Einschränkungen

- **Verzögerung:** Die Station überträgt ihre Werte alle 10 Minuten, die öffentlichen Stationen
  ebenso. Ein Regenalarm kommt deshalb bis zu etwa 10 Minuten später als bei einem beheizten
  Regensensor. Für Markisen, die beim ersten Tropfen einfahren sollen, bleibt ein eigener
  Regensensor die sicherere Wahl.
- Die **Helligkeit** ist ein Näherungswert aus Wetterdienstdaten, siehe [Helligkeit](#helligkeit).
- Werte, für die free@home keinen Datenpunkt hat, werden nicht übertragen: Lautstärke,
  Regenmengen (mm), Windrichtung, Minimum-/Maximumtemperaturen.
- Unterstützt wird nur die Netatmo **Wetterstation** (NAMain mit Modulen NAModule1–4), nicht der
  Healthy Home Coach oder andere Netatmo-Produkte. Stationen, denen man nur als Favorit folgt, werden
  nicht verwendet.
- Die free@home-Gerätetypen der Local API sind nur knapp dokumentiert. Das Addon schreibt nur auf
  Datenpunkte, die der SysAP für das Gerät tatsächlich meldet. Die Einheiten folgen der Referenz der
  Pairing IDs der free@home Local API: Helligkeit in lx, Windgeschwindigkeit in m/s, Luftdruck in Pa
  (Netatmo liefert hPa, das Addon rechnet um).
- Getestet mit Unit- und Integrationstests gegen eine simulierte Netatmo-Cloud und einen simulierten
  System Access Point, jeweils mit der echten free@home-Bibliothek. Der Speicherbedarf liegt etwa
  beim [Somfy-TaHoma-Connector](https://github.com/dn-falk/somfy-freeathome-connector) (SysAP-Grenze
  64 MB pro Addon).

## Entwicklung

```bash
npm ci
npm test            # Unit- und Integrationstests (Netatmo-Simulator, Fake-SysAP, echte free@home-Bibliothek)
npm run build       # TypeScript -> build/
npm run pack        # installierbares Addon-Archiv (.tar)
```

**Addon auf dem PC gegen den eigenen SysAP laufen lassen.** Das Addon darf dabei nicht gleichzeitig
auf dem SysAP laufen, sonst gibt es die Geräte doppelt.

```bash
export FREEATHOME_BASE_URL=http://<SysAP-IP>
export FREEATHOME_API_USERNAME=<Local-API-Benutzer>
export FREEATHOME_API_PASSWORD=<Passwort>
npm run build && npm start
```

**Ohne Netatmo-Konto:** `npm run mock -- --port 18080 --rain 0.2` startet eine simulierte
Netatmo-Cloud (Station „Zuhause“ mit Außen- und Innenmodul, öffentliche Stationen mit Regen und
Wind) und einen simulierten Wetterdienst. Das Addon dann mit
`NETATMO_API_URL=http://localhost:18080 OPEN_METEO_URL=http://localhost:18080 BRIGHT_SKY_URL=http://localhost:18080 npm start`
starten und Client ID `client-id`, Client Secret `client-secret` und Refresh Token `refresh-0`
eintragen.

### Releases

Releases erstellt GitHub Actions. Enthält `main` eine Version, die noch nicht veröffentlicht ist,
führt die CI die Tests aus, baut das Archiv und veröffentlicht das Release `v<version>` mit der
Datei `netatmo-weather-connector-<version>.tar`. Für eine neue Version die Version auf einem Branch
erhöhen und in `main` mergen:

```bash
npm version 1.1.0 --no-git-tag-version   # package.json und package-lock.json
# und dieselbe "version" in free-at-home-metadata.json eintragen
```

### Aufbau

```
src/
  main.ts                  Einstieg: free@home-Bibliothek, Addon-Konfiguration, RPC, Signale
  app.ts                   (Neu-)Start der Verbindung bei Konfigurationsänderungen, speichert den Refresh Token, Status
  config.ts                liest und prüft die Einstellungen der Addon-Oberfläche
  status.ts                Statusanzeige (Einstellungen, Anwendungsstatus)
  bridge/bridge.ts         Abfragezyklus: Netatmo, Wetterkarte, Helligkeit -> free@home-Geräte
  bridge/plan.ts           welche free@home-Geräte es für Stationen und Einstellungen gibt
  bridge/weather.ts        Werte der Wetterstation inkl. Rückgriff auf die Wetterkarte und Haltezeit des Regenalarms
  fah/                     virtuelle free@home-Geräte, Datenpunkte und Alarme, Geräteverwaltung
  netatmo/                 Client der Netatmo-API, Token-Erneuerung, Daten von Station und Wetterkarte
  weather/                 Helligkeit: Wetterdienste, Sonnenstand, Dämmerung
test/                      Tests inkl. Netatmo-Simulator und Fake-System-Access-Point
tools/mock-netatmo.ts      simulierte Netatmo-Cloud für die Entwicklung
```

## Lizenz und rechtliche Hinweise

- **Kein offizielles Produkt:** Dieses Addon ist ein unabhängiges Community-Projekt und kein Produkt
  von Netatmo, Legrand oder ABB/Busch-Jaeger. Diese Unternehmen haben es weder beauftragt noch
  geprüft, zertifiziert oder freigegeben und leisten dafür keinen Support.
- **Support:** Fragen und Fehler bitte über die
  [Issues](https://github.com/dn-falk/netatmo-ws-freeathome-connector/issues) dieses Repositorys
  melden, nicht beim Support von Netatmo oder Busch-Jaeger.
- **Marken:** Netatmo, Legrand, free@home, Busch-free@home, Busch-Jaeger und ABB sind Marken oder
  eingetragene Marken ihrer jeweiligen Inhaber. Sie werden hier nur verwendet, um zu beschreiben, mit
  welchen Produkten das Addon zusammenarbeitet. Daraus ergibt sich keine Verbindung zu den
  Markeninhabern und keine Empfehlung durch sie. Es werden keine Herstellerlogos verwendet.
- **Schnittstellen und Daten:** Das Addon nutzt nur offiziell dokumentierte Schnittstellen: die
  Netatmo-Connect-Weather-API mit eigener App und eigenem Token, die Local API und
  Addon-Schnittstelle des free@home System Access Point sowie die öffentlichen APIs der
  Wetterdienste. Wetterdaten von [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Quelle der
  DWD-Daten: Deutscher Wetterdienst, über [Bright Sky](https://brightsky.dev/).
- **Lizenz und Haftung:** MIT-Lizenz, siehe [LICENSE](LICENSE). Die Software wird ohne jede Gewähr
  bereitgestellt; Nutzung auf eigene Verantwortung. Auf die Werte der Wetterstation des Addons darf
  man sich nicht zum Schutz von Personen oder Sachwerten verlassen.
