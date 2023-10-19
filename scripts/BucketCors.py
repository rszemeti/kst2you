import json
from google.cloud import storage
from google.oauth2 import service_account

cors_config = [
    {
        "origin": ["*"],
        "method": ["GET", "HEAD", "OPTIONS"],
        "responseHeader": ["*"],
        "maxAgeSeconds": 3600
    }
]

with open('kst-chat-f252ab4938bf.json', 'r') as credentials_file:
    credentials = json.load(credentials_file)

    client = storage.Client(credentials=service_account.Credentials.from_service_account_info(credentials))

    # Specify the bucket and file name in the Google Cloud Storage bucket
    bucket_name = 'kst2you'
    bucket = client.get_bucket(bucket_name)
    bucket.cors = cors_config
    bucket.patch()
