"""
Contest Log — standalone Cloud Function for contest session persistence.

Deploy as a separate function (e.g. 'contest-log') in the kst-chat GCP project.
  gcloud functions deploy contest-log \
      --runtime python312 \
      --trigger-http \
      --allow-unauthenticated \
      --region europe-west2 \
      --entry-point main \
      --source .

Firestore collection: contest_logs
Document structure:
  {
    callsign:  str,          # base callsign (uppercase, no /P etc.)
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
  contestLoad        — return the active session for a callsign
  contestReset       — archive current session (sets active=false), does NOT delete
  contestRestore     — reactivate an archived session (archives current one first)
  contestList        — list all sessions for a callsign
  contestLoadSession — load a specific session by ID
"""

import json
import functions_framework
from google.cloud import firestore
from datetime import datetime


COLLECTION = 'contest_logs'
USER_SETTINGS_COLLECTION = 'user_settings'

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
    else:
        result = {'status': 'error', 'message': f'Unknown action: {action}'}

    return (json.dumps(result), 200, {**CORS_HEADERS, 'Content-Type': 'application/json'})


def contest_save(data):
    """Save/update the active contest session for a callsign."""
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    log = data.get('log', {'worked': [], 'skip': []})
    settings = data.get('settings', {})
    name = (data.get('name') or '').strip()
    incoming_count = len(log.get('worked', [])) + len(log.get('skip', []))

    db = firestore.Client()
    col = db.collection(COLLECTION)

    # Find active session for this callsign
    active_docs = list(
        col.where('callsign', '==', callsign)
           .where('active', '==', True)
           .limit(1)
           .stream()
    )

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
            'entryCount': incoming_count,
        }
        if name:
            update_fields['name'] = name
        doc_ref.update(update_fields)
        doc_id = active_docs[0].id
    else:
        # Create new
        doc_id = f"{callsign}_{int(now.timestamp())}"
        col.document(doc_id).set({
            'callsign': callsign,
            'name': name or 'Untitled session',
            'active': True,
            'createdAt': now,
            'updatedAt': now,
            'log': log,
            'settings': settings,
            'entryCount': incoming_count,
        })
        # Track active session in user settings
        _set_active_session(db, callsign, doc_id)

    return {'status': 'ok', 'sessionId': doc_id, 'entryCount': incoming_count}


def contest_load(data):
    """Load the active contest session for a callsign."""
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    db = firestore.Client()
    col = db.collection(COLLECTION)

    active_docs = list(
        col.where('callsign', '==', callsign)
           .where('active', '==', True)
           .limit(1)
           .stream()
    )

    if active_docs:
        doc = active_docs[0]
        d = doc.to_dict()
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
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    db = firestore.Client()
    col = db.collection(COLLECTION)

    now = datetime.utcnow()

    # Mark all active sessions for this callsign as archived
    active_docs = list(
        col.where('callsign', '==', callsign)
           .where('active', '==', True)
           .stream()
    )
    for doc in active_docs:
        doc.reference.update({
            'active': False,
            'archivedAt': now,
        })

    # Clear active session in user settings
    _set_active_session(db, callsign, None)

    return {'status': 'ok', 'archived': len(active_docs)}


def contest_restore(data):
    """Reactivate an archived session, archiving any currently active one first."""
    callsign = (data.get('callsign') or '').upper().strip()
    session_id = (data.get('sessionId') or '').strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}
    if not session_id:
        return {'status': 'error', 'message': 'Missing sessionId'}

    db = firestore.Client()
    col = db.collection(COLLECTION)
    now = datetime.utcnow()

    # Verify target session exists and belongs to this callsign
    target_doc = col.document(session_id).get()
    if not target_doc.exists:
        return {'status': 'error', 'message': 'Session not found'}
    target_data = target_doc.to_dict()
    if target_data.get('callsign') != callsign:
        return {'status': 'error', 'message': 'Session does not belong to this callsign'}

    # Archive any currently active sessions
    active_docs = list(
        col.where('callsign', '==', callsign)
           .where('active', '==', True)
           .stream()
    )
    for doc in active_docs:
        doc.reference.update({'active': False, 'archivedAt': now})

    # Reactivate the target session
    col.document(session_id).update({
        'active': True,
        'updatedAt': now,
    })
    # Remove archivedAt if present
    col.document(session_id).update({
        'archivedAt': firestore.DELETE_FIELD,
    })

    # Update user settings
    _set_active_session(db, callsign, session_id)

    # Return the restored session data
    d = col.document(session_id).get().to_dict()
    return {
        'status': 'ok',
        'sessionId': session_id,
        'name': d.get('name', ''),
        'log': d.get('log', {'worked': [], 'skip': []}),
        'settings': d.get('settings', {}),
    }

    """List all sessions (active + archived) for a callsign, newest first."""
    callsign = (data.get('callsign') or '').upper().strip()
    if not callsign:
        return {'status': 'error', 'message': 'Missing callsign'}

    db = firestore.Client()
    col = db.collection(COLLECTION)

    docs = list(
        col.where('callsign', '==', callsign)
           .order_by('createdAt', direction=firestore.Query.DESCENDING)
           .stream()
    )

    sessions = []
    for doc in docs:
        d = doc.to_dict()
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


# ── User Settings ────────────────────────────────────────────────────────────

def _set_active_session(db, callsign, session_id):
    """Update the activeSessionId in user settings."""
    doc_ref = db.collection(USER_SETTINGS_COLLECTION).document(callsign)
    doc_ref.set({'activeSessionId': session_id, 'updatedAt': datetime.utcnow()}, merge=True)
