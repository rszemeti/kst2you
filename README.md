# KST2You

A modern web interface for the [ON4KST](https://www.on4kst.info/) VHF/UHF chat system, with aircraft scatter tracking and beacon monitoring.

## [Launch KST2You](https://rszemeti.github.io/kst2you/)

---

## Features

- **Chat** — Live KST chat with distance filtering and personal message highlighting
- **Users** — Sortable user list showing callsign, locator, distance, and bearing from your QTH
- **Map** — Real-time map of active stations
- **Aircraft Scatter** — Live aircraft overlay using [airplanes.live](https://airplanes.live/) data, showing potential scatter paths between you and other stations
- **Beacons** — Spotted beacon log with band and locator information
- **Contest Log** — Session QSO logging

## Getting Started

1. Open [KST2You](https://rszemeti.github.io/kst2you/) in your browser
2. Enter your KST callsign and password when prompted
3. The app connects to KST via a community-maintained proxy network — no local software needed


## Using KST2You

### Chat

The Chat tab shows the live KST message stream. Use the distance filter to limit what you see to stations within a given range, or tick **Only messages about me** to show only messages addressed to your callsign.

Click any callsign in the **From** or **To** column to open a private chat window for that station. The chat window shows your full message history with that station, your distance and bearing to them, and a text box to send a direct message. If the station is between 5 and 900 km away a **Check Scatter** button appears — clicking it switches straight to the Scatter tab with that station pre-loaded as the target. Messages are stored locally in your browser so the history survives a page reload.

An unread-message badge in the navbar tracks incoming directed messages while you are in another tab.

### Map

The Map tab shows all active KST stations plotted on a Google Map, centred on your locator. Your own position is shown as a blue dot; other stations are green (active) or red (away). Distance rings are drawn at 100, 200, 300, 500, and 1000 km. An optional Maidenhead grid overlay can be toggled on.

Click any station marker to see a pop-up with their callsign and a **Chat** button that opens the private chat window for that station. Double-click anywhere on the map to get the grid square, distance, and bearing to that point.

### Users

The Users tab is a sortable, searchable table of everyone currently logged in to KST, with callsign, name, locator, distance/bearing from your QTH, and last-seen time. Click any row to open a chat window with that station. Each locator cell has a small ✈ button — clicking it jumps straight to the Scatter tab with that station set as the target.

### Aircraft Scatter

The Scatter tab lets you check whether any aircraft are currently in a position to provide a scatter path between you and another station.

Station A (your locator) is filled in automatically when you log in. Set Station B to the target station's locator — or click ✈ next to their entry in the Users tab, or click their callsign on the scatter map. Choose the band, adjust the corridor angle and lookahead time if needed, then press **Scan**.

Aircraft that fall within the scatter corridor are plotted on the map and listed below it. Click any aircraft icon for flight details. The map also shows all online KST stations (blue = you, yellow = current target, green = active, red = away), so you can switch target simply by clicking a station marker.

If a rotator controller web server is running on localhost, KST2You will detect it automatically and a **Point Rotator** button will appear in the chat window and scatter controls.

### Contest Mode

Contest mode adds a session log and keeps track of which stations you have worked or skipped. When active, a **Worked / Skip** scoreboard badge appears in the navbar and a **Session Log** tab is added.

In any chat window, buttons let you mark that station as **Worked** or **Skip**. Worked stations are greyed out in the user list and dimmed on the map; skipped stations are hidden, keeping the display focused on new opportunities.

## Running Your Own Proxy

KST2You relies on WebSocket proxies to bridge the KST TCP chat service into the browser. If you'd like to contribute a proxy and help improve reliability for all users, see [KST_PROXY_SETUP.md](KST_PROXY_SETUP.md) for setup instructions.

Once your proxy is running, get in touch and it can be added to the pool.

## Aircraft Data

Aircraft scatter data is provided by [airplanes.live](https://airplanes.live/) via [api.airplanes.live](https://api.airplanes.live/v2/) for live ADS-B aircraft state data.

## Contributing

Pull requests are welcome. The site is a static single-page app deployed via GitHub Pages — all source is under [docs/](docs/).
