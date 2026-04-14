"""
User Settings — standalone HTTP backend for per-user preferences.

Currently deployed on Cloud Run at:
    https://kst-user-settings-852912082756.europe-west1.run.app

Historical note: this script was originally prepared for Google Cloud Functions.
The current deployment is Cloud Run, but the HTTP contract is unchanged.

Firestore collection: user_settings
Document ID: backupKey (uppercase/hex namespace key)
Fields: { activeSessionId, passwordHash, passwordSalt, updatedAt, ... }

Actions (POST JSON body with {action, data}):
  userSettingsGet  — return user settings (excludes passwordHash)
  userSettingsSave — upsert user settings; hashes 'password' field if provided
    userSettingsDelete — delete user settings for a backup namespace
"""

import json
import hashlib
import os
import functions_framework
from google.cloud import firestore
from datetime import datetime, timedelta


COLLECTION = 'user_settings'
RETENTION_WINDOW = timedelta(days=365)

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
    elif action == 'userSettingsDelete':
        result = user_settings_delete(data)
    else:
        result = {'status': 'error', 'message': f'Unknown action: {action}'}

    return (json.dumps(result), 200, {**CORS_HEADERS, 'Content-Type': 'application/json'})


def user_settings_get(data):
    """Return user settings for a backup namespace."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    doc_ref = db.collection(COLLECTION).document(backup_key)
    doc = doc_ref.get()

    if not doc.exists:
        return {'status': 'ok', 'settings': {}}

    d = doc.to_dict()
    now = datetime.utcnow()
    if _is_stale(d, now):
        doc_ref.delete()
        return {'status': 'ok', 'settings': {}}

    doc_ref.update({'lastAccessed': now})
    # Never return password credentials to the client
    d.pop('passwordHash', None)
    d.pop('passwordSalt', None)
    d.pop('lastAccessed', None)
    return {'status': 'ok', 'settings': d}


def user_settings_save(data):
    """Upsert user settings. If 'password' is provided, store its SHA-256 hash."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

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

    db = firestore.Client()
    doc_ref = db.collection(COLLECTION).document(backup_key)
    existing = doc_ref.get().to_dict()
    now = datetime.utcnow()

    if existing and _is_stale(existing, now):
        doc_ref.delete()

    settings['updatedAt'] = now
    settings['lastAccessed'] = now
    doc_ref.set(settings, merge=True)

    return {'status': 'ok'}


def user_settings_delete(data):
    """Delete user settings for a backup namespace."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    db.collection(COLLECTION).document(backup_key).delete()
    return {'status': 'ok'}


def _get_backup_key(data):
    return ((data.get('backupKey') or data.get('callsign') or '').strip()).upper()


def _is_stale(doc_data, now):
    reference_time = doc_data.get('lastAccessed') or doc_data.get('updatedAt')
    if not reference_time:
        return False

    return now - reference_time > RETENTION_WINDOW
