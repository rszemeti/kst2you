"""Transparent WebSocket-to-TCP proxy for ON4KST.

This is a small, KST-aware replacement candidate for websockify. Each browser
WebSocket connection gets its own upstream TCP connection to the KST server.
KST protocol bytes are relayed unchanged in both directions.

Run:
    python scripts/kst_ws_proxy.py --listen-port 8766
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
from itertools import count
from pathlib import Path


LOGGER = logging.getLogger("kst-ws-proxy")
CONNECTION_IDS = count(1)
MICROWAVE_BANDS = ("1296", "2320", "3400", "5760", "10368", "24048", "47000")


class _InvalidHandshakeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        error = record.exc_info[1] if record.exc_info else None
        while error:
            if type(error).__name__ == "InvalidMessage" and "HTTP request" in str(error):
                return False
            error = error.__cause__ or error.__context__
        return True


def configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    for name in ("websockets.server", "websockets.asyncio.server"):
        logging.getLogger(name).addFilter(_InvalidHandshakeFilter())


def _display_chunk(chunk: bytes, limit: int = 240) -> str:
    text = chunk.decode("utf-8", errors="replace").replace("\r", "\\r").replace("\n", "\\n")
    if len(text) > limit:
        return text[:limit] + "..."
    return text


# Kept outside the repo so writes don't trigger dev-server live reloads.
DEFAULT_STATE_PATH = Path.home() / ".kst2you" / "kst_ws_proxy_state.json"


class KstWebSocketProxy:
    def __init__(self, upstream_host: str, upstream_port: int, verbose: bool = False, state_path: str | Path = DEFAULT_STATE_PATH) -> None:
        self.upstream_host = upstream_host
        self.upstream_port = upstream_port
        self.verbose = verbose
        self.state_path = Path(state_path)
        self.state = self._load_state()
        # Backed by self.state["locators"] so precise locators survive proxy restarts.
        self.precise_locators = self.state["locators"]
        self.connection_callsigns = {}
        self.connection_chat_ids = {}
        self.active_websockets = {}
        self.sent_band_activity = set()
        self.sent_peer_snapshot = set()
        self.announced_self_to_peers = set()

    def _load_state(self) -> dict:
        # JSON file for now; swap for a Firestore-backed store later without changing callers.
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            state = {}
        state.setdefault("band_activity", {})
        state.setdefault("locators", {})
        return state

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=2, sort_keys=True), encoding="utf-8")

    def _band_activity_for(self, callsign: str) -> dict[str, bool]:
        stored = self.state.setdefault("band_activity", {}).get(callsign.upper(), {})
        return {band: bool(stored.get(band, False)) for band in MICROWAVE_BANDS}

    def _store_band_activity(self, callsign: str, bands: dict) -> None:
        normalized = {band: bool(bands.get(band, False)) for band in MICROWAVE_BANDS}
        self.state.setdefault("band_activity", {})[callsign.upper()] = normalized
        self._save_state()

    async def _send_band_activity(self, connection_id: int, websocket) -> None:
        if connection_id in self.sent_band_activity:
            return
        callsign = self.connection_callsigns.get(connection_id)
        if not callsign or self.connection_chat_ids.get(connection_id) != "3":
            return
        self.sent_band_activity.add(connection_id)
        payload = {
            "kst2you": "bandActivity",
            "callsign": callsign,
            "bands": self._band_activity_for(callsign),
        }
        await websocket.send(json.dumps(payload, separators=(",", ":")) + "\r\n")

    async def _send_peer_snapshot(self, connection_id: int, websocket) -> None:
        if connection_id in self.sent_peer_snapshot:
            return
        callsign = self.connection_callsigns.get(connection_id)
        if not callsign or self.connection_chat_ids.get(connection_id) != "3":
            return

        me = callsign.upper()
        # Only users connected via this proxy can keep their bands current;
        # stored activity for anyone else may be stale.
        online = {
            peer.upper()
            for peer_id, peer in self.connection_callsigns.items()
            if self.connection_chat_ids.get(peer_id) == "3"
        }
        sent_count = 0
        for peer_callsign, peer_bands in self.state.get("band_activity", {}).items():
            if peer_callsign.upper() == me or peer_callsign.upper() not in online:
                continue
            payload = {
                "kst2you": "bandActivityPeer",
                "callsign": peer_callsign.upper(),
                "bands": {band: bool(peer_bands.get(band, False)) for band in MICROWAVE_BANDS},
            }
            await websocket.send(json.dumps(payload, separators=(",", ":")) + "\r\n")
            sent_count += 1

        self.sent_peer_snapshot.add(connection_id)
        LOGGER.info("[%s] sent peer band-activity snapshot for %s (%d peers)", connection_id, callsign, sent_count)

    async def _announce_self_to_peers(self, connection_id: int) -> None:
        # Pushes a reconnecting user's already-persisted band activity to peers
        # who are already online, so they don't have to wait for a fresh Save.
        if connection_id in self.announced_self_to_peers:
            return
        callsign = self.connection_callsigns.get(connection_id)
        if not callsign or self.connection_chat_ids.get(connection_id) != "3":
            return
        self.announced_self_to_peers.add(connection_id)
        bands = self._band_activity_for(callsign)
        if not any(bands.values()):
            return
        await self._broadcast_peer_band_activity(callsign, bands, exclude_connection_id=connection_id)
        LOGGER.info("[%s] announced %s's persisted band activity to online peers", connection_id, callsign)

    async def _broadcast_peer_band_activity(self, callsign: str, bands: dict[str, bool], exclude_connection_id: int | None = None) -> None:
        payload = json.dumps(
            {
                "kst2you": "bandActivityPeer",
                "callsign": callsign.upper(),
                "bands": {band: bool(bands.get(band, False)) for band in MICROWAVE_BANDS},
            },
            separators=(",", ":"),
        ) + "\r\n"

        targets = []
        for target_id, websocket in self.active_websockets.items():
            if exclude_connection_id is not None and target_id == exclude_connection_id:
                continue
            if self.connection_chat_ids.get(target_id) != "3":
                continue
            if not self.connection_callsigns.get(target_id):
                continue
            targets.append((target_id, websocket))

        LOGGER.info("[%s] broadcasting %s's band activity to %d peer(s)", exclude_connection_id, callsign, len(targets))
        if not targets:
            return

        send_tasks = [websocket.send(payload) for _, websocket in targets]
        results = await asyncio.gather(*send_tasks, return_exceptions=True)
        for (target_id, _), result in zip(targets, results):
            if isinstance(result, Exception):
                LOGGER.debug("[%s] peer band activity send failed: %s", target_id, result)

    def _parse_custom_browser_payload(self, chunk: bytes) -> dict | None:
        text = chunk.decode("utf-8", errors="replace").strip()
        if not text or not text.startswith("{"):
            return None
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
        if payload.get("kst2you") != "bandActivityUpdate":
            return None
        return payload

    async def handle_client(self, websocket) -> None:
        connection_id = next(CONNECTION_IDS)
        peer = getattr(websocket, "remote_address", None)
        LOGGER.info("[%s] browser connected: %s", connection_id, peer)
        self.active_websockets[connection_id] = websocket
        try:
            reader, writer = await asyncio.open_connection(self.upstream_host, self.upstream_port)
        except OSError as error:
            LOGGER.error("[%s] upstream connect failed: %s", connection_id, error)
            self.active_websockets.pop(connection_id, None)
            await websocket.close(code=1011, reason="KST upstream unavailable")
            return

        LOGGER.info("[%s] upstream connected: %s:%d", connection_id, self.upstream_host, self.upstream_port)
        upstream_task = asyncio.create_task(self._tcp_to_websocket(connection_id, reader, websocket))
        browser_task = asyncio.create_task(self._websocket_to_tcp(connection_id, websocket, writer))
        done, pending = await asyncio.wait(
            {upstream_task, browser_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            if task.exception():
                LOGGER.debug("[%s] relay task ended: %s", connection_id, task.exception())

        writer.close()
        await writer.wait_closed()
        await websocket.close()
        self.connection_callsigns.pop(connection_id, None)
        self.connection_chat_ids.pop(connection_id, None)
        self.active_websockets.pop(connection_id, None)
        self.sent_band_activity.discard(connection_id)
        self.sent_peer_snapshot.discard(connection_id)
        self.announced_self_to_peers.discard(connection_id)
        LOGGER.info("[%s] closed", connection_id)

    def _rewrite_kst_chunk(self, connection_id: int, chunk: bytes) -> str:
        text = chunk.decode("utf-8", errors="replace")
        parts = re.split(r"(\r\n|\r|\n)", text)
        rewritten = []
        for part in parts:
            if part in ("\r\n", "\r", "\n"):
                rewritten.append(part)
                continue
            rewritten.append(self._rewrite_kst_frame(connection_id, part))
        return "".join(rewritten)

    def _precise_locator_for(self, callsign: str, locator: str) -> str | None:
        precise = self.precise_locators.get(callsign.upper())
        if precise and locator and precise[:6] == locator[:6].upper():
            return precise
        return None

    def _rewrite_kst_frame(self, connection_id: int, frame: str) -> str:
        fields = frame.split("|")
        frame_type = fields[0] if fields else ""
        if frame_type == "LOGSTAT" and len(fields) > 8:
            callsign = self.connection_callsigns.get(connection_id)
            precise = self._precise_locator_for(callsign or "", fields[8])
            if precise:
                fields[8] = precise
                return "|".join(fields)
        if frame_type in ("UA0", "UA5", "UM3") and len(fields) > 4:
            precise = self._precise_locator_for(fields[2], fields[4])
            if precise:
                fields[4] = precise
                return "|".join(fields)
        if frame_type == "LOC" and len(fields) > 3:
            precise = self._precise_locator_for(fields[2], fields[3])
            if precise:
                fields[3] = precise
                return "|".join(fields)
        return frame

    def _handle_custom_browser_frame(self, connection_id: int, frame: str) -> bool:
        text = frame.strip()
        if not text.startswith("{"):
            return False
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return False
        if payload.get("kst2you") != "bandActivityUpdate":
            return False
        callsign = self.connection_callsigns.get(connection_id)
        if callsign:
            self._store_band_activity(callsign, payload.get("bands", {}))
            LOGGER.info("[%s] stored band activity for %s", connection_id, callsign)
        return True

    def _rewrite_browser_chunk(self, connection_id: int, chunk: bytes) -> bytes:
        text = chunk.decode("utf-8", errors="replace")
        parts = re.split(r"(\r\n|\r|\n)", text)
        rewritten = []
        drop_separator = False
        for part in parts:
            if part in ("\r\n", "\r", "\n"):
                if drop_separator:
                    drop_separator = False
                    continue
                rewritten.append(part)
                continue
            if self._handle_custom_browser_frame(connection_id, part):
                drop_separator = True
                continue
            rewritten.append(self._rewrite_browser_frame(connection_id, part))
        return "".join(rewritten).encode("utf-8")

    def _rewrite_browser_frame(self, connection_id: int, frame: str) -> str:
        fields = frame.split("|")
        if fields and fields[0] in ("LOGIN", "LOGINC", "LOGINP") and len(fields) > 3:
            self.connection_callsigns[connection_id] = fields[1].upper()
            self.connection_chat_ids[connection_id] = fields[3]
        for index, field in enumerate(fields):
            if not field.upper().startswith("/SETLOC "):
                continue
            command, locator = field.split(None, 1)
            locator = locator.strip().upper()
            if len(locator) <= 6:
                return frame
            callsign = self.connection_callsigns.get(connection_id)
            if callsign:
                self.precise_locators[callsign] = locator
                self._save_state()
            fields[index] = f"{command} {locator[:6]}"
            LOGGER.info("[%s] stored precise locator %s, forwarding %s", connection_id, locator, locator[:6])
            return "|".join(fields)
        return frame

    async def _tcp_to_websocket(self, connection_id: int, reader: asyncio.StreamReader, websocket) -> None:
        while True:
            chunk = await reader.read(8192)
            if not chunk:
                LOGGER.info("[%s] upstream closed", connection_id)
                return
            if self.verbose:
                LOGGER.info("[%s] KST -> browser %s", connection_id, _display_chunk(chunk))
            # Send as a TEXT frame, not BINARY. Browsers (and Kst.js) generally
            # expect ws.onmessage's event.data to be a string for a line-based
            # text protocol like KST. Sending raw `bytes` makes the websockets
            # library emit a BINARY frame, which arrives in JS as a Blob/
            # ArrayBuffer instead of a string -- code that does JSON.parse(),
            # string concatenation, regex matching, etc. on that will throw,
            # and depending on how the caller handles the error, the socket
            # can appear to silently die right after connecting.
            #
            # KST's stream can contain stray Telnet IAC negotiation bytes
            # (0xFF ...) that aren't valid UTF-8; errors="replace" swaps those
            # for the U+FFFD replacement character rather than crashing the
            # decode. If you need byte-perfect fidelity (e.g. to handle IAC
            # sequences client-side), strip/handle Telnet negotiation here
            # instead of blindly decoding.
            await websocket.send(self._rewrite_kst_chunk(connection_id, chunk))

    async def _websocket_to_tcp(self, connection_id: int, websocket, writer: asyncio.StreamWriter) -> None:
        async for message in websocket:
            if isinstance(message, str):
                chunk = message.encode("utf-8")
            else:
                chunk = bytes(message)

            payload = self._parse_custom_browser_payload(chunk)
            if payload is not None:
                callsign = self.connection_callsigns.get(connection_id)
                if callsign:
                    normalized_bands = {band: bool(payload.get("bands", {}).get(band, False)) for band in MICROWAVE_BANDS}
                    self._store_band_activity(callsign, normalized_bands)
                    LOGGER.info("[%s] stored band activity for %s", connection_id, callsign)
                    await self._broadcast_peer_band_activity(callsign, normalized_bands, exclude_connection_id=connection_id)
                continue

            chunk = self._rewrite_browser_chunk(connection_id, chunk)
            if self.verbose:
                LOGGER.info("[%s] browser -> KST %s", connection_id, _display_chunk(chunk))
            writer.write(chunk)
            await writer.drain()
            await self._send_band_activity(connection_id, websocket)
            await self._send_peer_snapshot(connection_id, websocket)
            await self._announce_self_to_peers(connection_id)


async def run_proxy(listen_host: str, listen_port: int, upstream_host: str, upstream_port: int, verbose: bool = False, state_path: str | Path = DEFAULT_STATE_PATH) -> None:
    try:
        import websockets
    except ImportError as error:
        raise SystemExit("Install dependencies with: python -m pip install websockets") from error

    proxy = KstWebSocketProxy(upstream_host, upstream_port, verbose, state_path)
    async with websockets.serve(proxy.handle_client, listen_host, listen_port):
        LOGGER.info("Listening on ws://%s:%d", listen_host, listen_port)
        LOGGER.info("Relaying to %s:%d", upstream_host, upstream_port)
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description="KST WebSocket-to-TCP proxy")
    parser.add_argument("--listen-host", default="localhost")
    parser.add_argument("--listen-port", type=int, default=8766)
    parser.add_argument("--upstream-host", default="www.on4kst.info")
    parser.add_argument("--upstream-port", type=int, default=23001)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_PATH))
    args = parser.parse_args()
    configure_logging(args.verbose)
    asyncio.run(run_proxy(args.listen_host, args.listen_port, args.upstream_host, args.upstream_port, args.verbose, args.state_file))


if __name__ == "__main__":
    main()