"""Desktop launcher for the DXLog UDP/WebSocket bridge.

Run with:
    python scripts/dxlog_bridge_gui.py
"""

from __future__ import annotations

import asyncio
import threading
import tkinter as tk
from datetime import datetime
from tkinter import messagebox, ttk

try:
    from .dxlog_udp_websocket import Bridge, QsoEvent, configure_logging, run
except ImportError:
    from dxlog_udp_websocket import Bridge, QsoEvent, configure_logging, run


class BridgeGui:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("DXLog Bridge")
        self.root.geometry("760x430")
        self.loop = None
        self.thread = None
        self.bridge = None
        self.status_var = tk.StringVar(value="Stopped")
        self.udp_var = tk.StringVar(value="12060")
        self.ws_var = tk.StringVar(value="8765")
        self.verbose_var = tk.BooleanVar(value=False)
        self._build()
        self._build_menu()
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build_menu(self) -> None:
        menu = tk.Menu(self.root)
        help_menu = tk.Menu(menu, tearoff=False)
        help_menu.add_command(label="DXLog setup", command=self.show_help)
        help_menu.add_separator()
        help_menu.add_command(label="About", command=self.show_about)
        menu.add_cascade(label="Help", menu=help_menu)
        self.root.configure(menu=menu)

    def _build(self) -> None:
        settings = ttk.LabelFrame(self.root, text="Bridge")
        settings.pack(fill="x", padx=10, pady=10)
        ttk.Label(settings, text="UDP port").grid(row=0, column=0, padx=6, pady=8)
        ttk.Entry(settings, textvariable=self.udp_var, width=8).grid(row=0, column=1)
        ttk.Label(settings, text="WebSocket port").grid(row=0, column=2, padx=6)
        ttk.Entry(settings, textvariable=self.ws_var, width=8).grid(row=0, column=3)
        ttk.Checkbutton(settings, text="Raw packet logging", variable=self.verbose_var).grid(row=0, column=4, padx=12)
        self.start_button = ttk.Button(settings, text="Start", command=self.start)
        self.start_button.grid(row=0, column=5, padx=6)
        self.stop_button = ttk.Button(settings, text="Stop", command=self.stop, state="disabled")
        self.stop_button.grid(row=0, column=6, padx=6)

        ttk.Label(self.root, textvariable=self.status_var).pack(anchor="w", padx=12)
        columns = ("time", "type", "call", "locator", "rst", "serial", "band", "mode")
        self.table = ttk.Treeview(self.root, columns=columns, show="headings", height=14)
        headings = {"time": "Time", "type": "Event", "call": "Callsign", "locator": "Locator",
                    "rst": "RST", "serial": "Serial", "band": "Band", "mode": "Mode"}
        for column in columns:
            self.table.heading(column, text=headings[column])
            self.table.column(column, width=90, anchor="center")
        self.table.pack(fill="both", expand=True, padx=10, pady=8)

    def show_help(self) -> None:
        window = tk.Toplevel(self.root)
        window.title("DXLog Bridge Help")
        window.geometry("820x760")
        window.transient(self.root)

        frame = ttk.Frame(window)
        frame.pack(fill="both", expand=True)
        canvas = tk.Canvas(frame, highlightthickness=0)
        scrollbar = ttk.Scrollbar(frame, orient="vertical", command=canvas.yview)
        content = ttk.Frame(canvas, padding=14)
        canvas.create_window((0, 0), window=content, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        content.bind("<Configure>", lambda event: canvas.configure(scrollregion=canvas.bbox("all")))

        ttk.Label(content, text="DXLog setup", font=("TkDefaultFont", 15, "bold")).pack(anchor="w")
        instructions = (
            "1. In DXLog, open Options and enable Enable network.\n"
            "2. Open Options > Configure network and set the UDP destination to "
            "127.0.0.1, port 12060.\n"
            "3. Open Options > Networking > Broadcast.\n"
            "4. Enable QSOs and Use N1MM QSO format.\n\n"
            "For an existing log, enable Broadcast entire log to synchronize it. "
            "This is a one-shot broadcast; no setting needs to be changed afterward.\n\n"
            "KST2You must be running with Contest Mode active to import QSOs as Worked. "
            "The bridge publishes locally on WebSocket port 8765."
        )
        ttk.Label(content, text=instructions, justify="left", wraplength=740).pack(anchor="w", pady=(8, 14))

    def show_about(self) -> None:
        messagebox.showinfo("DXLog Bridge", "DXLog/N1MM UDP to KST2You WebSocket bridge")

    def start(self) -> None:
        try:
            udp_port, ws_port = int(self.udp_var.get()), int(self.ws_var.get())
        except ValueError:
            messagebox.showerror("Invalid port", "Ports must be numbers.")
            return
        self.loop = asyncio.new_event_loop()
        self.bridge = Bridge(self.event_received, self.status, self.verbose_var.get())
        self.thread = threading.Thread(target=self._run, args=(udp_port, ws_port), daemon=True)
        self.thread.start()
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")

    def _run(self, udp_port: int, ws_port: int) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(run(udp_port, "127.0.0.1", ws_port, self.bridge))
        except OSError as error:
            self.root.after(0, lambda: self.status_var.set(f"Error: {error}"))

    def status(self, message: str) -> None:
        self.root.after(0, lambda: self.status_var.set(message))

    def event_received(self, event: QsoEvent) -> None:
        self.root.after(0, self._add_event, event)

    def _add_event(self, event: QsoEvent) -> None:
        rst = f"{event.rst_sent or ''}/{event.rst_received or ''}"
        serial = f"{event.serial_sent or ''}/{event.serial_received or ''}"
        self.table.insert("", "end", values=(event.timestamp or datetime.now().strftime("%H:%M:%S"), event.type,
                              event.callsign, event.locator or "", rst, serial,
                              event.band or "", event.mode or ""))
        self.table.yview_moveto(1.0)

    def stop(self) -> None:
        if self.bridge:
            self.loop.call_soon_threadsafe(self.bridge.request_stop)
        self.status_var.set("Stopped")
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")

    def close(self) -> None:
        self.stop()
        self.root.destroy()


def main() -> None:
    configure_logging(False)
    root = tk.Tk()
    BridgeGui(root)
    root.mainloop()


if __name__ == "__main__":
    main()