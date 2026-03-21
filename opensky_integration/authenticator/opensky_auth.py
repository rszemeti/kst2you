"""
OpenSky Authenticator
---------------------
A lightweight local proxy that sits in the system tray and lets
browser-based applications obtain OpenSky OAuth2 tokens without
being blocked by CORS.

Listens on http://localhost:7329/token

Dependencies:
    pip install flask requests pystray pillow

Build exe:
    pip install pyinstaller
    pyinstaller --onefile --windowed --icon=icon.ico opensky_auth.py
"""

import threading
import sys
import os
import requests
from flask import Flask, request, jsonify
from PIL import Image, ImageDraw
import pystray

PORT = 7329
OPENSKY_TOKEN_URL = (
    'https://auth.opensky-network.org/auth/realms/opensky-network'
    '/protocol/openid-connect/token'
)

# ── Flask app ──────────────────────────────────────────────────────────────────

app = Flask(__name__)

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}

@app.after_request
def add_cors(response):
    for k, v in CORS_HEADERS.items():
        response.headers[k] = v
    return response

@app.route('/token', methods=['OPTIONS'])
def preflight():
    return ('', 204)

@app.route('/token', methods=['POST'])
def token():
    body = request.get_json(silent=True) or {}
    client_id     = body.get('client_id')
    client_secret = body.get('client_secret')

    if not client_id or not client_secret:
        return jsonify(error='Missing client_id or client_secret'), 400

    try:
        r = requests.post(
            OPENSKY_TOKEN_URL,
            data={
                'grant_type':    'client_credentials',
                'client_id':     client_id,
                'client_secret': client_secret,
            },
            timeout=10,
        )
        return (r.text, r.status_code, {'Content-Type': 'application/json'})
    except requests.exceptions.RequestException as e:
        return jsonify(error=str(e)), 502

def run_flask():
    # Suppress Flask startup noise
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    app.run(host='127.0.0.1', port=PORT)

# ── System tray ────────────────────────────────────────────────────────────────

def make_icon():
    """Generate a simple coloured square icon if no .ico file is present."""
    img = Image.new('RGB', (64, 64), color=(30, 120, 200))
    d = ImageDraw.Draw(img)
    # Draw a simple 'O' shape to hint at OpenSky
    d.ellipse([8, 8, 56, 56], outline=(255, 255, 255), width=6)
    return img

def load_icon():
    ico_path = os.path.join(os.path.dirname(sys.executable
                if getattr(sys, 'frozen', False) else __file__), 'icon.ico')
    if os.path.exists(ico_path):
        return Image.open(ico_path)
    return make_icon()

def on_quit(icon, item):
    icon.stop()
    os.kill(os.getpid(), 9)

def main():
    # Start Flask in a daemon thread
    t = threading.Thread(target=run_flask, daemon=True)
    t.start()

    # System tray
    icon = pystray.Icon(
        'OpenSky Authenticator',
        load_icon(),
        'OpenSky Authenticator\nRunning on port 7329',
        menu=pystray.Menu(
            pystray.MenuItem('OpenSky Authenticator', None, enabled=False),
            pystray.MenuItem(f'Listening on port {PORT}', None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Quit', on_quit),
        )
    )
    icon.run()

if __name__ == '__main__':
    main()
