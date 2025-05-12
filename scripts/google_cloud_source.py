import requests
import csv
from io import StringIO
from google.cloud import firestore
from google.cloud import storage
import json

headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://ukrepeater.net",
}

base_url = "https://beaconspot.uk/test/api/bsdl.php?band=%d"

def fetch_band_data(band):
    url = base_url % band
    response = requests.get(url, headers=headers)
    response.raise_for_status()

    csv_file = StringIO(response.text)
    reader = csv.DictReader(csv_file)
    return [
        {
            "band": row['Band'],
            "callsign": row['Beacon'],
            "frequency": row['Frequency'],
            "locator": row['Locator'],
            "location": row['Location'],
            "antenna": row['Antenna'],
            "heading": row['Heading'],
            "power": row['Power'],
            "status": 'O' if row['Status'] == 'QRV' else 'X',
            "date_last_spot": row['DateLastSpot'],
        }
        for row in reader if row['Band'] == str(band)
    ]

def update_firestore(beacons, band):
    db = firestore.Client()
    collection = db.collection('beacons')

    # Optionally: delete existing documents for that band
    existing_docs = collection.where("band", "==", str(band)).stream()
    for doc in existing_docs:
        doc.reference.delete()

    for beacon in beacons:
        doc_id = f"{beacon['band']}_{beacon['callsign']}"
        collection.document(doc_id).set(beacon)



def upload_summary_to_bucket(data, bucket_name, filename):
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(filename)

    json_str = json.dumps(data, indent=4)
    blob.upload_from_string(json_str, content_type='application/json')
    print(f"Uploaded JSON summary to gs://{bucket_name}/{filename}")


def main(request):
    all_collected_beacons = []

    for band in [40, 50, 70, 144, 432, 1296, 1297, 2320, 3400, 5760, 10368, 24048]:
        try:
            print(f"Fetching band {band}")
            beacons = fetch_band_data(band)
            print(f"Fetched {len(beacons)} beacons for band {band}")
            update_firestore(beacons, band)
            all_collected_beacons.extend(beacons)  # ✅ collect all beacons
        except Exception as e:
            print(f"Error updating band {band}: {e}")

    # ✅ Create and upload JSON summary
    all_beacons_summary = [
        {
            "callsign": b["callsign"],
            "frequency": float(b["frequency"]),
            "locator": b["locator"],
            "comment": b["location"],  # Assuming 'location' = 'comment'
            "status": b["status"],
        }
        for b in all_collected_beacons
    ]

    upload_summary_to_bucket(
        data=all_beacons_summary,
        bucket_name="kst2you",
        filename="BeaconList.json"
    )

    print("Beacon update complete")
    return "OK"


