"""
Contest Log — standalone HTTP backend for contest session persistence.

Currently deployed on Cloud Run at:
    https://kst-contest-log-852912082756.europe-west1.run.app

Historical note: this script was originally prepared for Google Cloud Functions.
The current deployment is Cloud Run, but the HTTP contract is unchanged.

Firestore collection: contest_logs
Document structure:
  {
    backupKey: str,          # credential-derived backup namespace key
    name:      str,          # user-chosen session name (e.g. "May 13cm log")
    active:    bool,         # true for the current session
    createdAt: timestamp,
    updatedAt: timestamp,
    log: {
      worked: [ {callsign, locator, dist, bearing, ts, rstSent, serialSent, rstRcvd, serialRcvd}, ... ],
      skip:   [ {callsign, locator, dist, bearing, ts}, ... ]
    },
    settings: {
      nextSerial:   int,
      exchangeMode: str
    }
  }

Actions (POST JSON body with {action, data}):
  contestSave        — upsert the active session (creates one if none exists)
    contestLoad        — return the active session for a backup namespace
  contestReset       — archive current session (sets active=false), does NOT delete
  contestRestore     — reactivate an archived session (archives current one first)
    contestList        — list all sessions for a backup namespace
  contestLoadSession — load a specific session by ID
    contestDeleteAll   — delete all contest sessions for a backup namespace
"""

import json
import functions_framework
from google.cloud import firestore
from datetime import datetime, timedelta


COLLECTION = 'contest_logs'
USER_SETTINGS_COLLECTION = 'user_settings'
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
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        return ('', 204, CORS_HEADERS)

    try:
        body = request.get_json(silent=True) or {}
    except Exception:
        return (json.dumps({'status': 'error', 'message': 'Invalid JSON'}), 400, CORS_HEADERS)

    action = body.get('action', '')
    data = body.get('data', {})

    if action == 'contestSave':
        result = contest_save(data)
    elif action == 'contestLoad':
        result = contest_load(data)
    elif action == 'contestReset':
        result = contest_reset(data)
    elif action == 'contestRestore':
        result = contest_restore(data)
    elif action == 'contestList':
        result = contest_list(data)
    elif action == 'contestLoadSession':
        result = contest_load_session(data)
    elif action == 'contestDeleteAll':
        result = contest_delete_all(data)
    else:
        result = {'status': 'error', 'message': f'Unknown action: {action}'}

    return (json.dumps(result), 200, {**CORS_HEADERS, 'Content-Type': 'application/json'})


def contest_save(data):
    """Save/update the active contest session for a backup namespace."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    log = data.get('log', {'worked': [], 'skip': []})
    settings = data.get('settings', {})
    name = (data.get('name') or '').strip()
    incoming_count = len(log.get('worked', [])) + len(log.get('skip', []))

    db = firestore.Client()
    if _purge_stale_namespace(db, backup_key):
        _set_active_session(db, backup_key, None)
    col = db.collection(COLLECTION)

    active_docs = _find_namespace_sessions(db, backup_key, active=True, limit=1)

    now = datetime.utcnow()

    if active_docs:
        existing = active_docs[0].to_dict()
        existing_log = existing.get('log', {'worked': [], 'skip': []})
        stored_count = len(existing_log.get('worked', [])) + len(existing_log.get('skip', []))

        # Guard: reject if incoming has fewer entries (likely stale/blank session)
        if incoming_count < stored_count:
            return {
                'status': 'conflict',
                'message': f'Server has {stored_count} entries, incoming has {incoming_count}. Merge required.',
                'serverLog': existing_log,
                'serverSettings': existing.get('settings', {}),
            }

        # Update existing
        doc_ref = active_docs[0].reference
        update_fields = {
            'log': log,
            'settings': settings,
            'updatedAt': now,
            'lastAccessed': now,
            'entryCount': incoming_count,
        }
        if name:
            update_fields['name'] = name
        doc_ref.update(update_fields)
        doc_id = active_docs[0].id
    else:
        # Create new
        doc_id = f"{backup_key}_{int(now.timestamp())}"
        col.document(doc_id).set({
            'backupKey': backup_key,
            'name': name or 'Untitled session',
            'active': True,
            'createdAt': now,
            'updatedAt': now,
            'lastAccessed': now,
            'log': log,
            'settings': settings,
            'entryCount': incoming_count,
        })
        # Track active session in user settings
        _set_active_session(db, backup_key, doc_id)

    _touch_namespace(db, backup_key)

    return {'status': 'ok', 'sessionId': doc_id, 'entryCount': incoming_count}


def contest_load(data):
    """Load the active contest session for a backup namespace."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    if _purge_stale_namespace(db, backup_key):
        _set_active_session(db, backup_key, None)
        return {'status': 'ok', 'sessionId': None, 'name': None, 'log': None, 'settings': None}

    col = db.collection(COLLECTION)

    active_docs = _find_namespace_sessions(db, backup_key, active=True, limit=1)

    if active_docs:
        doc = active_docs[0]
        d = doc.to_dict()
        now = datetime.utcnow()
        doc.reference.update({'lastAccessed': now})
        _touch_namespace(db, backup_key, now)
        return {
            'status': 'ok',
            'sessionId': doc.id,
            'name': d.get('name', ''),
            'log': d.get('log', {'worked': [], 'skip': []}),
            'settings': d.get('settings', {}),
        }

    return {'status': 'ok', 'sessionId': None, 'name': None, 'log': None, 'settings': None}


def contest_reset(data):
    """Archive the current session and return confirmation."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    if _purge_stale_namespace(db, backup_key):
        _set_active_session(db, backup_key, None)
        return {'status': 'ok', 'archived': 0}

    col = db.collection(COLLECTION)

    now = datetime.utcnow()

    active_docs = _find_namespace_sessions(db, backup_key, active=True)
    for doc in active_docs:
        doc.reference.update({
            'active': False,
            'archivedAt': now,
            'lastAccessed': now,
        })

    # Clear active session in user settings
    _set_active_session(db, backup_key, None)
    _touch_namespace(db, backup_key, now)

    return {'status': 'ok', 'archived': len(active_docs)}


def contest_restore(data):
    """Reactivate an archived session, archiving any currently active one first."""
    backup_key = _get_backup_key(data)
    session_id = (data.get('sessionId') or '').strip()
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}
    if not session_id:
        return {'status': 'error', 'message': 'Missing sessionId'}

    db = firestore.Client()
    if _purge_stale_namespace(db, backup_key):
        _set_active_session(db, backup_key, None)
        return {'status': 'error', 'message': 'Session not found'}

    col = db.collection(COLLECTION)
    now = datetime.utcnow()

    # Verify target session exists and belongs to this backup namespace
    target_doc = col.document(session_id).get()
    if not target_doc.exists:
        return {'status': 'error', 'message': 'Session not found'}
    target_data = target_doc.to_dict()
    if _get_doc_backup_key(target_data) != backup_key:
        return {'status': 'error', 'message': 'Session does not belong to this backup namespace'}

    # Archive any currently active sessions
    active_docs = _find_namespace_sessions(db, backup_key, active=True)
    for doc in active_docs:
        doc.reference.update({'active': False, 'archivedAt': now, 'lastAccessed': now})

    # Reactivate the target session
    col.document(session_id).update({
        'active': True,
        'updatedAt': now,
        'lastAccessed': now,
    })
    # Remove archivedAt if present
    col.document(session_id).update({
        'archivedAt': firestore.DELETE_FIELD,
    })

    # Update user settings
    _set_active_session(db, backup_key, session_id)
    _touch_namespace(db, backup_key, now)

    # Return the restored session data
    d = col.document(session_id).get().to_dict()
    return {
        'status': 'ok',
        'sessionId': session_id,
        'name': d.get('name', ''),
        'log': d.get('log', {'worked': [], 'skip': []}),
        'settings': d.get('settings', {}),
    }


def contest_list(data):
    """List all sessions (active + archived) for a backup namespace, newest first."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    if _purge_stale_namespace(db, backup_key):
        _set_active_session(db, backup_key, None)
        return {'status': 'ok', 'sessions': []}

    col = db.collection(COLLECTION)

    docs = _find_namespace_sessions(db, backup_key, order_by_created_desc=True)

    now = datetime.utcnow()
    _touch_namespace(db, backup_key, now)

    sessions = []
    for doc in docs:
        d = doc.to_dict()
        if _is_stale_doc(d, now):
            doc.reference.delete()
            continue

        doc.reference.update({'lastAccessed': now})
        log = d.get('log', {'worked': [], 'skip': []})
        worked_count = len([e for e in log.get('worked', []) if not e.get('deleted')])
        skip_count = len([e for e in log.get('skip', []) if not e.get('deleted')])
        created = d.get('createdAt')
        archived = d.get('archivedAt')
        sessions.append({
            'sessionId': doc.id,
            'name': d.get('name', ''),
            'active': d.get('active', False),
            'createdAt': created.isoformat() if created else None,
            'archivedAt': archived.isoformat() if archived else None,
            'workedCount': worked_count,
            'skipCount': skip_count,
        })

    return {'status': 'ok', 'sessions': sessions}


def contest_load_session(data):
    """Load a specific session by document ID (for viewing archived sessions)."""
    session_id = (data.get('sessionId') or '').strip()
    if not session_id:
        return {'status': 'error', 'message': 'Missing sessionId'}

    db = firestore.Client()
    doc = db.collection(COLLECTION).document(session_id).get()

    if not doc.exists:
        return {'status': 'error', 'message': 'Session not found'}

    d = doc.to_dict()
    now = datetime.utcnow()
    if _is_stale_doc(d, now):
        doc.reference.delete()
        return {'status': 'error', 'message': 'Session not found'}

    doc.reference.update({'lastAccessed': now})
    _touch_namespace(db, _get_doc_backup_key(d), now)
    return {
        'status': 'ok',
        'sessionId': doc.id,
        'name': d.get('name', ''),
        'active': d.get('active', False),
        'log': d.get('log', {'worked': [], 'skip': []}),
        'settings': d.get('settings', {}),
        'createdAt': d.get('createdAt').isoformat() if d.get('createdAt') else None,
        'archivedAt': d.get('archivedAt').isoformat() if d.get('archivedAt') else None,
    }


def contest_delete_all(data):
    """Delete all contest sessions for a backup namespace."""
    backup_key = _get_backup_key(data)
    if not backup_key:
        return {'status': 'error', 'message': 'Missing backupKey'}

    db = firestore.Client()
    docs = _find_namespace_sessions(db, backup_key)
    for doc in docs:
        doc.reference.delete()

    _set_active_session(db, backup_key, None)
    return {'status': 'ok', 'deleted': len(docs)}


# ── User Settings ────────────────────────────────────────────────────────────

def _set_active_session(db, backup_key, session_id):
    """Update the activeSessionId in user settings."""
    doc_ref = db.collection(USER_SETTINGS_COLLECTION).document(backup_key)
    now = datetime.utcnow()
    doc_ref.set({'activeSessionId': session_id, 'updatedAt': now, 'lastAccessed': now}, merge=True)


def _touch_namespace(db, backup_key, now=None):
    if not backup_key:
        return

    timestamp = now or datetime.utcnow()
    db.collection(USER_SETTINGS_COLLECTION).document(backup_key).set({
        'lastAccessed': timestamp,
        'updatedAt': timestamp,
    }, merge=True)


def _purge_stale_namespace(db, backup_key):
    doc_ref = db.collection(USER_SETTINGS_COLLECTION).document(backup_key)
    snapshot = doc_ref.get()
    if not snapshot.exists:
        return False

    data = snapshot.to_dict() or {}
    if not _is_stale_doc(data, datetime.utcnow()):
        return False

    docs = _find_namespace_sessions(db, backup_key)
    for doc in docs:
        doc.reference.delete()
    doc_ref.delete()
    return True


def _find_namespace_sessions(db, backup_key, active=None, order_by_created_desc=False, limit=None):
    docs_by_id = {}
    collection = db.collection(COLLECTION)

    for field_name in ('backupKey', 'callsign'):
        for doc in collection.where(field_name, '==', backup_key).stream():
            docs_by_id[doc.id] = doc

    docs = list(docs_by_id.values())
    if active is not None:
        docs = [doc for doc in docs if (doc.to_dict() or {}).get('active') == active]
    if order_by_created_desc:
        docs.sort(key=lambda doc: (doc.to_dict() or {}).get('createdAt') or datetime.min, reverse=True)
    if limit is not None:
        docs = docs[:limit]
    return docs


def _get_doc_backup_key(doc_data):
    return (doc_data.get('backupKey') or doc_data.get('callsign') or '').upper().strip()


def _is_stale_doc(doc_data, now):
    reference_time = (
        doc_data.get('lastAccessed')
        or doc_data.get('updatedAt')
        or doc_data.get('archivedAt')
        or doc_data.get('createdAt')
    )
    if not reference_time:
        return False

    return now - reference_time > RETENTION_WINDOW


def _get_backup_key(data):
    return ((data.get('backupKey') or data.get('callsign') or '').strip()).upper()
