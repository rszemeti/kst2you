"""
User Settings — standalone Cloud Function for per-user preferences.

Deploy as a separate function (e.g. 'user-settings') in the kst-chat GCP project.
  gcloud functions deploy user-settings \
      --runtime python312 \
      --trigger-http \
      --allow-unauthenticated \
      --region europe-west2 \
      --entry-point main \
      --source .

Firestore collection: user_settings
Document ID: callsign (uppercase)
Fields: { activeSessionId, passwordHash, passwordSalt, updatedAt, ... }

Actions (POST JSON body with {action, data}):
  userSettingsGet  — return user settings (excludes passwordHash)
  userSettingsSave — upsert user settings; hashes 'password' field if provided
"""

import json
import hashlib
import os
import functions_framework
from google.cloud import firestore
from datetime import datetime


COLLECTION = 'user_settings'

# Allow CORS for browser requests
CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}


@functions_framework.http
def main(request):
    """HTTP Cloud Function entry point."""
    if request.method == 'OPTIONS':
        return ('', 204, CORS_HEADERS)

    try:
        body = request.get_json(silent=True) or {}
    except Exception:
        return (json.dumps({'status': 'error', 'message': 'Invalid JSON'}), 400, CORS_HEADERS)

    action = body.get('action', '')
    data = body.get('data', {})

    if action == 'userSettingsGet':
        result = user_settings_get(data)
    elif action == 'userSettingsSave':
        result = user_settings_save(data)
    else:
        result = {'status': 'error', 'message': f'Unknown action: {action}'}

    return (json.dumps(result), 200, {**CORS_HEADERS, 'Content-Type': 'application/json'})


def user_settings_get(data):
    """Return user settings for a callsign."""
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    db = firestore.Client()
    doc = db.collection(COLLECTION).document(callsign).get()

    if not doc.exists:
        return {'status': 'ok', 'settings': {}}

    d = doc.to_dict()
    # Never return password credentials to the client
    d.pop('passwordHash', None)
    d.pop('passwordSalt', None)
    return {'status': 'ok', 'settings': d}


def user_settings_save(data):
    """Upsert user settings. If 'password' is provided, store its SHA-256 hash."""
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    settings = data.get('settings', {})
    if not settings:
        return {'status': 'error', 'message': 'No settings provided'}

    # Hash password with a random salt if supplied, never store plaintext
    password = settings.pop('password', None)
    if password:
        salt = os.urandom(16)
        settings['passwordSalt'] = salt.hex()
        settings['passwordHash'] = hashlib.pbkdf2_hmac(
            'sha256', password.encode('utf-8'), salt, iterations=100_000
        ).hex()

    settings['updatedAt'] = datetime.utcnow()

    db = firestore.Client()
    db.collection(COLLECTION).document(callsign).set(settings, merge=True)

    return {'status': 'ok'}
