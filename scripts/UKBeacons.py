import requests
import csv
from io import StringIO

from BeaconDatabase import BeaconDatabase
from BeaconDatabase import Beacon

db = BeaconDatabase(host='localhost', username='beacons', password='wibble', database='beacons')

# Define the URL of the CSV file
url = "https://ukrepeater.net/csvcreate_beacons.php"

# Define the Referer header
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://ukrepeater.net",
}

try:
    # Send an HTTP GET request to the URL with the Referer header
    response = requests.get(url, headers=headers)

    # Check if the request was successful (status code 200)
    if response.status_code == 200:
        csv_data = response.text
        csv_file = StringIO(csv_data)
        csv_reader = csv.reader(csv_file)
        data = []

        source=1
        for row in csv_reader:
            beacon = Beacon(row[0], float(row[1]), row[2], row[3], ('O' if row[10] == 'OPERATIONAL' else 'X'))
            data.append(beacon)

        db.update_beacons(data,source)


    else:
        print(f"Failed to retrieve data. Status code: {response.status_code}")

except requests.exceptions.RequestException as e:
    print(f"Request error: {e}")
except Exception as e:
    print(f"An error occurred: {e}")

db.disconnect()
