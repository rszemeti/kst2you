import mysql.connector
import json
from google.cloud import storage
from google.oauth2 import service_account
from BeaconDatabase import BeaconDatabase

db = BeaconDatabase(host='localhost', username='beacons', password='wibble', database='beacons')
db.connect()
json_data = json.dumps(db.get_beacons(), indent=4)

with open('kst-chat-f252ab4938bf.json', 'r') as credentials_file:
    credentials = json.load(credentials_file)

    client = storage.Client(credentials=service_account.Credentials.from_service_account_info(credentials))

    # Specify the bucket and file name in the Google Cloud Storage bucket
    bucket_name = 'kst2you'
    file_name = 'BeaconList2.json'

    # Upload the JSON data to the specified bucket and file
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(file_name)
    blob.upload_from_string(json_data, content_type='application/json')

    print(f'JSON data uploaded to gs://{bucket_name}/{file_name}')
