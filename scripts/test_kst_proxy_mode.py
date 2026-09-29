"""Test KST LOGINP/AUSER proxy mode over raw TCP.

The script prompts for passwords with getpass unless they are supplied on the
command line. Outgoing frame logs redact passwords either way.

Example:
    python scripts/test_kst_proxy_mode.py --host 10.231.13.225 --proxy-call ON4KST --user-call ON4KST-2
"""

from __future__ import annotations

import argparse
import getpass
import os
import socket
import time


DEFAULT_PORT = 23001
CONNECTION_CLOSED = "__CONNECTION_CLOSED__"
OMIT_FINAL_PIPE = False


def log(line: str) -> None:
    print(line, flush=True)


class ProtocolReader:
    def __init__(self, connection: socket.socket) -> None:
        self.connection = connection
        self.buffer = b""

    def read_line(self, timeout: float) -> str | None:
        deadline = time.monotonic() + timeout
        while b"\r\n" not in self.buffer and time.monotonic() < deadline:
            self.connection.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                chunk = self.connection.recv(8192)
            except socket.timeout:
                return None
            if not chunk:
                return ""
            self.buffer += chunk

        if b"\r\n" not in self.buffer:
            if not self.buffer:
                return None
            line = self.buffer
            self.buffer = b""
            return line.decode("utf-8", errors="replace")

        line, self.buffer = self.buffer.split(b"\r\n", 1)
        return line.decode("utf-8", errors="replace")


def send_frame(connection: socket.socket, frame: str, *secrets: str) -> None:
    if OMIT_FINAL_PIPE and frame.endswith("|"):
        frame = frame[:-1]
    wire = frame + "\r\n"
    shown = frame if frame else "<CRLF>"
    for secret in secrets:
        if secret:
            shown = shown.replace(secret, "********")
    log(f">>> {shown}")
    connection.sendall(wire.encode("ascii", errors="replace"))


def handle_server_frame(connection: socket.socket, chat: str, proxy_call: str, frame: str) -> None:
    if frame == "CK|":
        send_frame(connection, "")
        return
    if frame.startswith("CKUSER|"):
        parts = frame.split("|")
        user_call = parts[2] if len(parts) > 2 and parts[2] else proxy_call
        send_frame(connection, f"OKUSER|{chat}|{user_call}|")


def read_frames(connection: socket.socket, reader: ProtocolReader, chat: str, proxy_call: str, seconds: float, stop_prefixes=()) -> list[str]:
    frames = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        frame = reader.read_line(max(0.1, deadline - time.monotonic()))
        if frame is None:
            continue
        if frame == "":
            log("<<< <connection closed>")
            frames.append(CONNECTION_CLOSED)
            break
        log(f"<<< {frame}")
        frames.append(frame)
        handle_server_frame(connection, chat, proxy_call, frame)
        if stop_prefixes and any(frame.startswith(prefix) for prefix in stop_prefixes):
            break
    return frames


def proxy_user_added(frames: list[str], user_call: str) -> bool:
    user_call = user_call.upper()
    return any(
        frame.startswith("LOGSTAT|200|") or frame.startswith((f"UA0|", f"UM3|", f"UA5|")) and f"|{user_call}|" in frame
        for frame in frames
    )


def proxy_user_rejected(frames: list[str]) -> bool:
    return any(frame.startswith(("LOGSTAT|1", "LOGSTAT|201|")) for frame in frames)


def connection_closed(frames: list[str]) -> bool:
    return CONNECTION_CLOSED in frames


def main() -> int:
    parser = argparse.ArgumentParser(description="Test KST proxy LOGINP/AUSER mode")
    parser.add_argument("--host", default="www.on4kst.info")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--chat", default="2")
    parser.add_argument("--version", default="KST2You proxy tester")
    parser.add_argument("--proxy-call", help="registered proxy callsign")
    parser.add_argument("--proxy-password", help="registered proxy password")
    parser.add_argument("--user-call", help="registered user callsign to add with AUSER")
    parser.add_argument("--user-password", help="registered user password")
    parser.add_argument("--past-messages", type=int, default=0, help="past chat messages requested at login")
    parser.add_argument("--past-dx-map", type=int, default=0, help="past DX/map frames requested at login")
    parser.add_argument("--auser-seconds", type=float, default=5, help="seconds to wait for AUSER success/error response")
    parser.add_argument("--sync-seconds", type=float, default=20, help="seconds to wait for initial frames after SDONE")
    parser.add_argument("--listen-seconds", type=float, default=30)
    parser.add_argument("--message", help="send this public test message as the AUSER callsign")
    parser.add_argument("--message-destination", default="0", help="message destination callsign or 0 for public")
    parser.add_argument("--no-sdone", action="store_true", help="skip SDONE after AUSER for comparison testing")
    parser.add_argument("--auser-after-sdone", action="store_true", help="send AUSER after SDONE and initial sync")
    parser.add_argument("--no-auser-wait", action="store_true", help="send SDONE immediately after AUSER")
    parser.add_argument("--omit-final-pipe", action="store_true", help="omit the final frame separator before CRLF")
    parser.add_argument("--send-message-anyway", action="store_true", help="send MSGP even if AUSER was not confirmed")
    parser.add_argument("--remove-user", action="store_true", help="send DUSER before exit")
    args = parser.parse_args()
    global OMIT_FINAL_PIPE
    OMIT_FINAL_PIPE = args.omit_final_pipe

    proxy_call = (args.proxy_call or input("Proxy callsign: ")).strip().upper()
    proxy_password = args.proxy_password or os.environ.get("KST_PROXY_PASSWORD")
    if proxy_password is None:
        proxy_password = getpass.getpass("Proxy password: ")
    user_call = (args.user_call or input("AUSER callsign: ")).strip().upper()
    user_password = args.user_password or os.environ.get("KST_USER_PASSWORD")
    if user_password is None:
        user_password = getpass.getpass("AUSER password: ")

    with socket.create_connection((args.host, args.port), timeout=10) as connection:
        reader = ProtocolReader(connection)
        log(f"Connected to {args.host}:{args.port}")

        banner = reader.read_line(10)
        if banner is not None:
            log(f"<<< {banner}")

        log("--- LOGINP ---")
        login = f"LOGINP|{proxy_call}|{proxy_password}|{args.chat}|{args.version}|{args.past_messages}|{args.past_dx_map}|1|0|0|"
        send_frame(connection, login, proxy_password)
        login_frames = read_frames(connection, reader, args.chat, proxy_call, 10, ("LOGSTAT|",))
        if not any(frame.startswith("LOGSTAT|100|") for frame in login_frames):
            log("Login did not return LOGSTAT|100; stopping before AUSER.")
            return 1

        auser_frames = []

        if not args.no_sdone:
            if not args.auser_after_sdone:
                log("--- AUSER ---")
                add_user = f"AUSER|{args.chat}|{user_call}|{user_password}|"
                send_frame(connection, add_user, user_password)
                if not args.no_auser_wait:
                    auser_frames = read_frames(connection, reader, args.chat, proxy_call, args.auser_seconds, ("LOGSTAT|200|", "LOGSTAT|1"))

            log("--- SDONE ---")
            send_frame(connection, f"SDONE|{args.chat}|")

            log("--- INITIAL SYNC ---")
            sync_frames = read_frames(connection, reader, args.chat, proxy_call, args.sync_seconds, (f"UE|{args.chat}|", f"ME|{args.chat}|"))
            if not any(frame.startswith((f"UE|{args.chat}|", f"ME|{args.chat}|")) for frame in sync_frames):
                log("Initial sync marker not seen before timeout; continuing with test message.")

            if args.auser_after_sdone:
                log("--- AUSER ---")
                add_user = f"AUSER|{args.chat}|{user_call}|{user_password}|"
                send_frame(connection, add_user, user_password)
                auser_frames = read_frames(connection, reader, args.chat, proxy_call, args.auser_seconds, ("LOGSTAT|200|", "LOGSTAT|1", f"UA5|{args.chat}|{user_call}|"))
        else:
            sync_frames = []
            log("--- AUSER ---")
            add_user = f"AUSER|{args.chat}|{user_call}|{user_password}|"
            send_frame(connection, add_user, user_password)
            auser_frames = read_frames(connection, reader, args.chat, proxy_call, args.auser_seconds, ("LOGSTAT|200|", "LOGSTAT|1"))

        if args.message and not args.send_message_anyway and not proxy_user_added(auser_frames + sync_frames, user_call):
            log(f"Proxy user {user_call} was not confirmed in chat {args.chat}; not sending MSGP.")
            if proxy_user_rejected(auser_frames + sync_frames):
                log("The server returned an error while adding the proxy user.")
            return 1

        if connection_closed(auser_frames + sync_frames):
            log("Connection closed before the test message could be sent.")
            return 1

        if args.message:
            log("--- MSGP ---")
            send_frame(connection, f"MSGP|{args.chat}|{user_call}|{args.message_destination}|{args.message}|0|")

        log("--- LISTEN ---")
        read_frames(connection, reader, args.chat, proxy_call, args.listen_seconds)

        if args.remove_user:
            send_frame(connection, f"DUSER|{args.chat}|{user_call}|")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())