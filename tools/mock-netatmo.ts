/**
 * Simulated Netatmo cloud (and weather services) for development without a Netatmo account.
 *
 *   npm run mock -- --port 18080 --rain 0.2
 *
 * The addon uses it when started with NETATMO_API_URL, OPEN_METEO_URL and BRIGHT_SKY_URL
 * pointing to it (see README, section "Development"). Client ID "client-id", client secret
 * "client-secret", refresh token "refresh-0".
 */
import { NetatmoSimulator } from "../test/support/netatmoSimulator";

function argument(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
    const port = Number(argument("port", "18080"));
    const rain = Number(argument("rain", "0"));
    const simulator = new NetatmoSimulator({
        radiation: Number(argument("radiation", "400")),
        publicStations: [
            { id: "70:ee:50:aa:00:01", location: [8.69, 50.112], temperature: 14.1, rainLive: rain },
            { id: "70:ee:50:aa:00:02", location: [8.70, 50.115], temperature: 14.5, rainLive: rain },
            { id: "70:ee:50:aa:00:03", location: [8.66, 50.10], temperature: 13.9, rainLive: 0 },
            { id: "70:ee:50:aa:00:04", location: [8.67, 50.12], wind: { strength: 12, gust: 25 } },
        ],
        log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    });
    const url = await simulator.listen(port, "0.0.0.0");
    console.log(`Simulated Netatmo cloud listening on ${url}`);
    console.log(`Client ID: ${simulator.clientId}, client secret: ${simulator.clientSecret}, refresh token: ${simulator.initialRefreshToken}`);
    console.log("Station 'Zuhause' with outdoor module 'Garten' and indoor module 'Schlafzimmer'; rain and wind from the weather map.");

    const shutdown = () => {
        void simulator.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

void main();
