# OpenSky Authenticator

A small Windows utility that runs in the system tray and allows the kst2you
scatter tool to authenticate with the OpenSky Network API.

Without it, the scatter tool runs in **anonymous mode** (60-second refresh).
With it running and your credentials entered, you get **10-second refresh**.

---

## Installation

1. Download **OpenSkyAuthenticator.exe** from the [latest release](../../releases/latest).
2. Double-click it — a small plane icon will appear in your system tray.
3. Open kst2you, go to the Scatter tab, and drop in your OpenSky credentials JSON when prompted.

That's it. The scatter tool detects the authenticator automatically.

---

## OpenSky Credentials

You need an OpenSky Network account with API client credentials:

1. Register at [opensky-network.org](https://opensky-network.org)
2. Go to your profile → **Client Credentials**
3. Create a new client and download the JSON file
4. Drop that JSON file into the credentials box in kst2you

---

## Run at Windows Startup

So the authenticator is always ready when you use kst2you:

1. Press **Win + R**, type `shell:startup`, press Enter
2. A folder opens — copy (or create a shortcut to) **OpenSkyAuthenticator.exe** into it

It will now start automatically every time you log into Windows and sit quietly
in the system tray using minimal resources.

### Alternative: Task Scheduler (runs even before login)

If you want it to start at boot rather than at login:

1. Open **Task Scheduler** (search in Start menu)
2. Click **Create Basic Task**
3. Name it `OpenSky Authenticator`
4. Trigger: **When the computer starts**
5. Action: **Start a program** → browse to `OpenSkyAuthenticator.exe`
6. On the final page, tick **Open the Properties dialog** → check **Run whether user is logged on or not**

---

## Troubleshooting

**Tray icon doesn't appear**
Windows SmartScreen may block unsigned executables. Click **More info → Run anyway**.

**kst2you still shows 60s refresh**
Make sure the tray icon is visible (check the hidden icons arrow in the taskbar).
The scatter tool checks for the authenticator every 30 seconds — wait a moment
after starting it, or reload the page.

**Credentials rejected**
Ensure you are using **client credentials** (client_id + client_secret), not your
OpenSky username and password. Download a fresh JSON from your OpenSky profile.

---

## How it works

OpenSky's OAuth2 token endpoint does not include CORS headers, which prevents
browser-based applications from fetching tokens directly. This utility runs a
tiny local web server on `http://localhost:7329` that proxies the token request
from the server side, where CORS does not apply.

Your credentials are sent only to `localhost` and directly to OpenSky —
nothing is stored on any external server.
