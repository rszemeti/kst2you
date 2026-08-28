# Aircraft Feed Service

This Compose deployment maintains one connection to a remote Beast feed with
`readsb` and exposes its decoded `aircraft.json` snapshot through a small,
read-only JSON API. It contains no user interface.

`readsb` updates the snapshot every second. Although readsb can also publish
JSON over a TCP port with `--net-json-port`, this service deliberately uses
`aircraft.json`: the API needs the complete current aircraft state to apply
each caller's route corridor filter, then returns ordinary HTTP JSON to
KST2You. Set the provider-supplied Beast hostname and port only in the ignored
`.env` file on the deployment host. The Compose build creates a minimal,
network-only `readsb` image from the pinned upstream source; it has no feeder,
statistics, map, or user-interface components.

## Local Smoke Test

With Docker Desktop running, copy `.env.example` to `.env` and run these from
this directory. This starts the feed decoder and API, exposing the latter only
on local port 8080; it does not need DNS, Nginx, or a TLS certificate.

```sh
docker compose up -d --build readsb api
```

In another terminal, wait a few seconds for aircraft state and request:

```sh
curl "http://localhost:8080/api/aircraft?fromLat=51.05&fromLon=-1.35&toLat=52.48&toLon=-1.90&allowanceKm=60"
```

Stop the decoder when finished with `docker compose down`.

## Deploy

1. Install Docker Engine and Docker Compose on the Linux host.
2. Copy `.env.example` to `.env`, then set the Beast hostname and port.
   `CORS_ORIGINS` is an exact comma-separated allowlist. In production set it
   to `https://rszemeti.github.io`; add local ports only while developing.
3. Point an `A` or `AAAA` DNS record for `DOMAIN_NAME` at the server's static
   IP, then allow inbound TCP ports 80 and 443 in the Lightsail firewall.
4. Obtain the initial certificate. This temporarily binds port 80, so do this
   before starting Nginx:

   ```sh
   docker compose run --rm --service-ports --entrypoint certbot certbot certonly --standalone \
     --non-interactive --agree-tos --email "$CERTBOT_EMAIL" \
     -d "$DOMAIN_NAME"
   ```

5. Start the complete service and the Certbot renewal companion:

   ```sh
   docker compose --profile certbot up -d --build
   ```

6. Check feed readiness through HTTPS Nginx:

   ```sh
   curl https://"$DOMAIN_NAME"/healthz
   ```

Nginx is the only service that publishes a host port. It proxies the API,
compresses JSON responses, rate-limits each source IP, serves the ACME
challenge, and terminates HTTPS. Certbot checks for renewal twice daily. After
renewal, Certbot signals Nginx to reload the certificate automatically within
30 seconds. No host cron job is required. Do not expose the API container
directly. Certificates are stored in the Docker named
`letsencrypt` volume, not in this repository. The service `.gitignore` also
excludes any local certificate or ACME directories if the volume arrangement
is ever changed.

## API

`GET /api/aircraft` is a public, rate-limited endpoint intended only for the
KST2You browser. It does not accept browser-held API keys: a static GitHub
Pages client cannot keep a secret. Nginx rate limits requests and CORS permits
only the configured KST2You origin.

Every request must include endpoint coordinates for an ellipse-like route
corridor. The filter keeps aircraft where the distance via the aircraft is at
most the direct route distance plus the specified allowance. `allowanceKm` is
limited to 200 km, so the API never returns the full global snapshot:

```text
GET /api/aircraft?fromLat=51.05&fromLon=-1.35&toLat=52.48&toLon=-1.90&allowanceKm=60
```

Aircraft lacking a decoded latitude or longitude are omitted only from a
route-filtered response. The API returns readsb-compatible aircraft objects so
the browser integration can normalize only the fields it needs.