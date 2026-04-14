import copy
import pathlib
import sys
import types
import unittest
from datetime import datetime
from unittest.mock import patch


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import contest_log_cloud
import user_settings_cloud


DELETE_FIELD = object()


class FakeDocumentSnapshot:
    def __init__(self, collection_ref, doc_id, data):
        self._collection_ref = collection_ref
        self.id = doc_id
        self._data = copy.deepcopy(data) if data is not None else None

    @property
    def exists(self):
        return self._data is not None

    @property
    def reference(self):
        return self._collection_ref.document(self.id)

    def to_dict(self):
        return copy.deepcopy(self._data) if self._data is not None else None


class FakeDocumentReference:
    def __init__(self, db, collection_name, doc_id):
        self._db = db
        self._collection_name = collection_name
        self.id = doc_id

    def get(self):
        data = self._db._collections.get(self._collection_name, {}).get(self.id)
        return FakeDocumentSnapshot(self._db.collection(self._collection_name), self.id, data)

    def set(self, data, merge=False):
        collection = self._db._collections.setdefault(self._collection_name, {})
        if merge and self.id in collection:
            merged = copy.deepcopy(collection[self.id])
            merged.update(copy.deepcopy(data))
            collection[self.id] = merged
        else:
            collection[self.id] = copy.deepcopy(data)

    def update(self, data):
        collection = self._db._collections.setdefault(self._collection_name, {})
        current = copy.deepcopy(collection.get(self.id, {}))
        for key, value in data.items():
            if value is DELETE_FIELD:
                current.pop(key, None)
            else:
                current[key] = copy.deepcopy(value)
        collection[self.id] = current

    def delete(self):
        collection = self._db._collections.setdefault(self._collection_name, {})
        collection.pop(self.id, None)


class FakeQuery:
    def __init__(self, db, collection_name, doc_ids=None):
        self._db = db
        self._collection_name = collection_name
        self._doc_ids = doc_ids

    def _all_items(self):
        collection = self._db._collections.get(self._collection_name, {})
        if self._doc_ids is None:
            items = list(collection.items())
        else:
            items = [(doc_id, collection[doc_id]) for doc_id in self._doc_ids if doc_id in collection]
        return items

    def where(self, field, op, value):
        if op != '==':
            raise NotImplementedError(f'Unsupported operator: {op}')
        matching_ids = [doc_id for doc_id, data in self._all_items() if data.get(field) == value]
        return FakeQuery(self._db, self._collection_name, matching_ids)

    def order_by(self, field, direction=None):
        reverse = direction == 'DESC'
        ordered_ids = [
            doc_id
            for doc_id, _ in sorted(
                self._all_items(),
                key=lambda item: item[1].get(field) or datetime.min,
                reverse=reverse,
            )
        ]
        return FakeQuery(self._db, self._collection_name, ordered_ids)

    def limit(self, count):
        limited_ids = [doc_id for doc_id, _ in self._all_items()[:count]]
        return FakeQuery(self._db, self._collection_name, limited_ids)

    def stream(self):
        return [
            FakeDocumentSnapshot(self._db.collection(self._collection_name), doc_id, data)
            for doc_id, data in self._all_items()
        ]


class FakeCollectionReference(FakeQuery):
    def __init__(self, db, collection_name):
        super().__init__(db, collection_name)

    def document(self, doc_id):
        return FakeDocumentReference(self._db, self._collection_name, doc_id)


class FakeFirestoreClient:
    def __init__(self):
        self._collections = {}

    def collection(self, name):
        self._collections.setdefault(name, {})
        return FakeCollectionReference(self, name)


class FakeRequest:
    def __init__(self, method='POST', json_body=None, json_exception=None):
        self.method = method
        self._json_body = json_body
        self._json_exception = json_exception

    def get_json(self, silent=True):
        if self._json_exception is not None:
            raise self._json_exception
        return self._json_body


class UserSettingsTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeFirestoreClient()
        self.firestore_stub = types.SimpleNamespace(Client=lambda: self.db)
        self.firestore_patch = patch.object(user_settings_cloud, 'firestore', self.firestore_stub)
        self.firestore_patch.start()

    def tearDown(self):
        self.firestore_patch.stop()

    def test_user_settings_get_strips_password_fields(self):
        self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').set({
            'rotatorType': 'pstrotator',
            'passwordHash': 'secret-hash',
            'passwordSalt': 'secret-salt',
        })

        result = user_settings_cloud.user_settings_get({'backupKey': 'g1yfg'})

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['settings'], {'rotatorType': 'pstrotator'})

    def test_user_settings_save_hashes_password_before_store(self):
        with patch.object(user_settings_cloud.os, 'urandom', return_value=b'\x01' * 16):
            result = user_settings_cloud.user_settings_save({
                'backupKey': 'g1yfg',
                'settings': {'password': 'swordfish', 'rotatorPort': '12000'},
            })

        stored = self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').get().to_dict()

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(stored['rotatorPort'], '12000')
        self.assertNotIn('password', stored)
        self.assertEqual(stored['passwordSalt'], '01' * 16)
        self.assertIn('passwordHash', stored)
        self.assertIsInstance(stored['updatedAt'], datetime)
        self.assertIsInstance(stored['lastAccessed'], datetime)

    def test_user_settings_get_purges_stale_settings(self):
        stale_time = datetime(2024, 1, 1, 12, 0, 0)
        self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').set({
            'rotatorType': 'pstrotator',
            'lastAccessed': stale_time,
        })

        with patch.object(user_settings_cloud, 'datetime') as mock_datetime:
            mock_datetime.utcnow.return_value = datetime(2026, 4, 14, 12, 0, 0)
            result = user_settings_cloud.user_settings_get({'backupKey': 'g1yfg'})

        stored = self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').get()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['settings'], {})
        self.assertFalse(stored.exists)

    def test_main_returns_400_for_invalid_json(self):
        response = user_settings_cloud.main(FakeRequest(json_exception=ValueError('bad json')))

        self.assertEqual(response[1], 400)
        self.assertIn('Invalid JSON', response[0])

    def test_user_settings_delete_removes_document(self):
        self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').set({
            'rotatorType': 'pstrotator',
        })

        result = user_settings_cloud.user_settings_delete({'backupKey': 'g1yfg'})

        self.assertEqual(result['status'], 'ok')
        self.assertFalse(self.db.collection(user_settings_cloud.COLLECTION).document('G1YFG').get().exists)


class ContestLogTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeFirestoreClient()
        self.firestore_stub = types.SimpleNamespace(
            Client=lambda: self.db,
            DELETE_FIELD=DELETE_FIELD,
            Query=types.SimpleNamespace(DESCENDING='DESC'),
        )
        self.firestore_patch = patch.object(contest_log_cloud, 'firestore', self.firestore_stub)
        self.firestore_patch.start()

    def tearDown(self):
        self.firestore_patch.stop()

    def test_contest_save_creates_session_and_updates_active_session_pointer(self):
        with patch.object(contest_log_cloud, 'datetime') as mock_datetime:
            mock_datetime.utcnow.return_value = datetime(2026, 4, 14, 12, 0, 0)
            result = contest_log_cloud.contest_save({
                'backupKey': 'g1yfg',
                'name': 'April activity',
                'log': {'worked': [{'callsign': 'M0ABC'}], 'skip': []},
                'settings': {'nextSerial': 4},
            })

        session_id = result['sessionId']
        stored = self.db.collection(contest_log_cloud.COLLECTION).document(session_id).get().to_dict()
        user_settings = self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').get().to_dict()

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['entryCount'], 1)
        self.assertEqual(stored['backupKey'], 'G1YFG')
        self.assertNotIn('callsign', stored)
        self.assertTrue(stored['active'])
        self.assertEqual(user_settings['activeSessionId'], session_id)
        self.assertIsInstance(stored['lastAccessed'], datetime)
        self.assertIsInstance(user_settings['lastAccessed'], datetime)

    def test_contest_save_rejects_stale_log_with_fewer_entries(self):
        self.db.collection(contest_log_cloud.COLLECTION).document('G1YFG_1').set({
            'backupKey': 'G1YFG',
            'active': True,
            'log': {'worked': [{'callsign': 'A'}, {'callsign': 'B'}], 'skip': []},
            'settings': {'nextSerial': 3},
        })

        result = contest_log_cloud.contest_save({
            'backupKey': 'g1yfg',
            'log': {'worked': [{'callsign': 'A'}], 'skip': []},
            'settings': {'nextSerial': 2},
        })

        self.assertEqual(result['status'], 'conflict')
        self.assertIn('serverLog', result)
        self.assertEqual(result['serverSettings'], {'nextSerial': 3})

    def test_contest_list_returns_counts_excluding_deleted_entries(self):
        self.db.collection(contest_log_cloud.COLLECTION).document('newer').set({
            'backupKey': 'G1YFG',
            'name': 'Newer',
            'active': False,
            'createdAt': datetime(2026, 4, 14, 12, 0, 0),
            'log': {
                'worked': [{'callsign': 'A'}, {'callsign': 'B', 'deleted': True}],
                'skip': [{'callsign': 'C'}],
            },
        })
        self.db.collection(contest_log_cloud.COLLECTION).document('older').set({
            'backupKey': 'G1YFG',
            'name': 'Older',
            'active': True,
            'createdAt': datetime(2026, 4, 13, 12, 0, 0),
            'archivedAt': datetime(2026, 4, 13, 18, 0, 0),
            'log': {'worked': [], 'skip': []},
        })

        result = contest_log_cloud.contest_list({'backupKey': 'g1yfg'})

        self.assertEqual(result['status'], 'ok')
        self.assertEqual([session['sessionId'] for session in result['sessions']], ['newer', 'older'])
        self.assertEqual(result['sessions'][0]['workedCount'], 1)
        self.assertEqual(result['sessions'][0]['skipCount'], 1)

    def test_contest_restore_reactivates_target_and_clears_archived_at(self):
        self.db.collection(contest_log_cloud.COLLECTION).document('active').set({
            'backupKey': 'G1YFG',
            'active': True,
            'log': {'worked': [], 'skip': []},
            'settings': {},
        })
        self.db.collection(contest_log_cloud.COLLECTION).document('archived').set({
            'backupKey': 'G1YFG',
            'active': False,
            'archivedAt': datetime(2026, 4, 13, 18, 0, 0),
            'log': {'worked': [{'callsign': 'A'}], 'skip': []},
            'settings': {'nextSerial': 7},
        })

        result = contest_log_cloud.contest_restore({'backupKey': 'g1yfg', 'sessionId': 'archived'})

        restored = self.db.collection(contest_log_cloud.COLLECTION).document('archived').get().to_dict()
        previous = self.db.collection(contest_log_cloud.COLLECTION).document('active').get().to_dict()
        user_settings = self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').get().to_dict()

        self.assertEqual(result['status'], 'ok')
        self.assertTrue(restored['active'])
        self.assertNotIn('archivedAt', restored)
        self.assertFalse(previous['active'])
        self.assertEqual(user_settings['activeSessionId'], 'archived')

    def test_main_handles_options_preflight(self):
        response = contest_log_cloud.main(FakeRequest(method='OPTIONS'))

        self.assertEqual(response[1], 204)
        self.assertEqual(response[2], contest_log_cloud.CORS_HEADERS)

    def test_contest_delete_all_removes_sessions(self):
        self.db.collection(contest_log_cloud.COLLECTION).document('G1YFG_1').set({
            'backupKey': 'G1YFG',
            'active': True,
            'createdAt': datetime(2026, 4, 14, 12, 0, 0),
            'log': {'worked': [], 'skip': []},
            'settings': {},
        })
        self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').set({
            'activeSessionId': 'G1YFG_1',
        })

        result = contest_log_cloud.contest_delete_all({'backupKey': 'g1yfg'})

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['deleted'], 1)
        self.assertFalse(self.db.collection(contest_log_cloud.COLLECTION).document('G1YFG_1').get().exists)
        self.assertIsNone(self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').get().to_dict()['activeSessionId'])

    def test_contest_load_purges_stale_namespace(self):
        stale_time = datetime(2024, 1, 1, 12, 0, 0)
        self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').set({
            'activeSessionId': 'G1YFG_1',
            'lastAccessed': stale_time,
        })
        self.db.collection(contest_log_cloud.COLLECTION).document('G1YFG_1').set({
            'backupKey': 'G1YFG',
            'active': True,
            'createdAt': stale_time,
            'log': {'worked': [{'callsign': 'A'}], 'skip': []},
            'settings': {'nextSerial': 3},
        })

        with patch.object(contest_log_cloud, 'datetime') as mock_datetime:
            mock_datetime.utcnow.return_value = datetime(2026, 4, 14, 12, 0, 0)
            result = contest_log_cloud.contest_load({'backupKey': 'g1yfg'})

        session_doc = self.db.collection(contest_log_cloud.COLLECTION).document('G1YFG_1').get()
        user_settings_doc = self.db.collection(contest_log_cloud.USER_SETTINGS_COLLECTION).document('G1YFG').get()

        self.assertEqual(result['status'], 'ok')
        self.assertIsNone(result['sessionId'])
        self.assertFalse(session_doc.exists)
        self.assertTrue(user_settings_doc.exists)
        self.assertIsNone(user_settings_doc.to_dict()['activeSessionId'])


if __name__ == '__main__':
    unittest.main()