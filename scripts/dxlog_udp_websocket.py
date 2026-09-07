"""Forward DXLog/N1MM contactinfo UDP broadcasts to WebSocket clients."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import socket
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass


LOGGER = logging.getLogger("dxlog-bridge")


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


@dataclass(frozen=True)
class QsoEvent:
    type: str
    callsign: str
    timestamp: str | None = None
    band: str | None = None
    mode: str | None = None
    locator: str | None = None
    rst_sent: str | None = None
    rst_received: str | None = None
    serial_sent: str | None = None
    serial_received: str | None = None


def _cabrillo_remote_fields(cabrillo: str | None, callsign: str) -> tuple[str, str, str] | None:
    if not cabrillo:
        return None
    match = re.search(
        rf"\b{re.escape(callsign)}\s+(\S+)\s+(\S+)\s+([A-Ra-r][A-Ra-r]\d{{2}}[A-Xa-x]{{2}})\b",
        cabrillo,
    )
    return (match.group(1), match.group(2), match.group(3).upper()) if match else None


def parse_qso_datagram(payload: bytes) -> QsoEvent | None:
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return None
    root_type = root.tag.rsplit("}", 1)[-1].lower()
    if root_type not in ("contactinfo", "contactreplace"):
        return None

    fields = {
        element.tag.rsplit("}", 1)[-1].lower(): (element.text or "").strip()
        for element in root.iter()
        if element is not root
    }

    def first(*names: str) -> str | None:
        return next((fields[name] for name in names if fields.get(name)), None)

    callsign = first("callsign", "call")
    if not callsign:
        return None
    remote = _cabrillo_remote_fields(fields.get("cabrillostring"), callsign)
    return QsoEvent(
        type="qso_replace" if root_type == "contactreplace" else "qso",
        callsign=callsign.upper(),
        timestamp=first("timestamp", "datetime", "date"),
        band=first("band"),
        mode=first("mode"),
        locator=first("gridsquare", "grid", "locator") or (remote[2] if remote else None),
        rst_sent=first("snt", "rstsent"),
        rst_received=first("rcv", "rstrcvd", "rstreceived") or (remote[0] if remote else None),
        serial_sent=first("sntnr", "serialsent"),
        serial_received=first("rcvnr", "serialreceived") or (remote[1] if remote else None),
    )


class Bridge:
    def __init__(self, on_event=None, on_status=None, verbose=False) -> None:
        self.clients = set()
        self.events: asyncio.Queue[QsoEvent] = asyncio.Queue()
        self.on_event = on_event
        self.on_status = on_status
        self.verbose = verbose
        self.stop_event = None

    def publish(self, event: QsoEvent) -> None:
        self.events.put_nowait(event)
        if self.on_event:
            self.on_event(event)

    def status(self, message: str) -> None:
        LOGGER.info(message)
        if self.on_status:
            self.on_status(message)

    def request_stop(self) -> None:
        if self.stop_event:
            self.stop_event.set()

    async def websocket_client(self, websocket) -> None:
        self.clients.add(websocket)
        self.status(f"Browser connected ({len(self.clients)})")
        try:
            await websocket.wait_closed()
        finally:
            self.clients.discard(websocket)
            self.status(f"Browser disconnected ({len(self.clients)})")

    async def broadcast(self) -> None:
        while True:
            event = await self.events.get()
            message = json.dumps(asdict(event), separators=(",", ":"))
            clients = tuple(self.clients)
            results = await asyncio.gather(
                *(client.send(message) for client in clients),
                return_exceptions=True,
            )
            for client, result in zip(clients, results):
                if isinstance(result, Exception):
                    self.clients.discard(client)


class UdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, bridge: Bridge) -> None:
        self.bridge = bridge

    def datagram_received(self, data: bytes, address) -> None:
        if self.bridge.verbose:
            LOGGER.info("UDP packet from %s: %r", address[0], data.decode("utf-8", errors="replace"))
        event = parse_qso_datagram(data)
        if event:
            self.bridge.status(f"QSO {event.callsign} ({event.locator or 'no locator'})")
            self.bridge.publish(event)
        else:
            self.bridge.status("Ignored non-QSO packet")


async def run(udp_port: int, ws_host: str, ws_port: int, bridge=None) -> None:
    try:
        import websockets
    except ImportError as error:
        raise SystemExit("Install dependencies with: python -m pip install websockets") from error

    bridge = bridge or Bridge()
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: UdpProtocol(bridge),
        local_addr=("0.0.0.0", udp_port),
        family=socket.AF_INET,
    )
    server = await websockets.serve(bridge.websocket_client, ws_host, ws_port)
    bridge.status(f"Listening UDP {udp_port} / WebSocket {ws_port}")
    bridge.stop_event = asyncio.Event()
    broadcast_task = asyncio.create_task(bridge.broadcast())
    try:
        await bridge.stop_event.wait()
    finally:
        broadcast_task.cancel()
        await asyncio.gather(broadcast_task, return_exceptions=True)
        transport.close()
        server.close()
        await server.wait_closed()


def main() -> None:
    parser = argparse.ArgumentParser(description="DXLog/N1MM UDP to WebSocket bridge")
    parser.add_argument("--udp-port", type=int, default=12060)
    parser.add_argument("--ws-host", default="127.0.0.1")
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    configure_logging(args.verbose)
    asyncio.run(run(args.udp_port, args.ws_host, args.ws_port))


if __name__ == "__main__":
    main()