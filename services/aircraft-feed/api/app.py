"""Read-only JSON API for the current readsb aircraft snapshot."""

import json
import math
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


AIRCRAFT_JSON_PATH = Path(os.environ.get("AIRCRAFT_JSON_PATH", "/data/aircraft.json"))
CORS_ORIGINS = frozenset(
    origin.strip() for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()
)
EARTH_RADIUS_KM = 6371.0088
MAX_ALLOWANCE_KM = 200


def distance_km(latitude_a, longitude_a, latitude_b, longitude_b):
    """Return the great-circle distance between two WGS84 positions."""
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    latitude_a = math.radians(latitude_a)
    latitude_b = math.radians(latitude_b)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude_a) * math.cos(latitude_b) * math.sin(longitude_delta / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(haversine))


def numeric_query(query, name):
    value = query.get(name, [None])[0]
    if value is None:
        raise ValueError(f"missing {name}")
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"invalid {name}") from exc


def filter_aircraft(aircraft, query):
    from_latitude = numeric_query(query, "fromLat")
    from_longitude = numeric_query(query, "fromLon")
    to_latitude = numeric_query(query, "toLat")
    to_longitude = numeric_query(query, "toLon")
    allowance_km = numeric_query(query, "allowanceKm")
    if not -90 <= from_latitude <= 90 or not -90 <= to_latitude <= 90:
        raise ValueError("latitude must be between -90 and 90")
    if not -180 <= from_longitude <= 180 or not -180 <= to_longitude <= 180:
        raise ValueError("longitude must be between -180 and 180")
    if not 0 <= allowance_km <= MAX_ALLOWANCE_KM:
        raise ValueError(f"allowanceKm must be between 0 and {MAX_ALLOWANCE_KM}")

    route_km = distance_km(from_latitude, from_longitude, to_latitude, to_longitude)
    filtered = []
    for item in aircraft:
        latitude = item.get("lat")
        longitude = item.get("lon")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue
        via_aircraft_km = (
            distance_km(from_latitude, from_longitude, latitude, longitude)
            + distance_km(latitude, longitude, to_latitude, to_longitude)
        )
        if via_aircraft_km <= route_km + allowance_km:
            filtered.append(item)
    return filtered


class AircraftHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        if urlparse(self.path).path != "/api/aircraft":
            self.send_error(404, "Not Found")
            return
        origin = self.headers.get("Origin", "")
        if origin not in CORS_ORIGINS:
            self.send_json(403, {"error": "origin is not allowed"})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_json(200, {"status": "ok", "snapshotAvailable": AIRCRAFT_JSON_PATH.is_file()})
            return
        if parsed.path != "/api/aircraft":
            self.send_error(404, "Not Found")
            return
        try:
            with AIRCRAFT_JSON_PATH.open(encoding="utf-8") as snapshot_file:
                snapshot = json.load(snapshot_file)
            aircraft = filter_aircraft(snapshot.get("aircraft", []), parse_qs(parsed.query))
        except FileNotFoundError:
            self.send_json(503, {"error": "aircraft snapshot is not ready"})
            return
        except (json.JSONDecodeError, ValueError) as exc:
            self.send_json(400, {"error": str(exc)})
            return

        self.send_json(200, {
            "now": snapshot.get("now"),
            "messages": snapshot.get("messages"),
            "aircraft": aircraft,
        })

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin in CORS_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        print(format_string % args)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), AircraftHandler).serve_forever()