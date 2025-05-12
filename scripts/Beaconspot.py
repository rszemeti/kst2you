import requests
import csv
from io import StringIO

from BeaconDatabase import BeaconDatabase
from BeaconDatabase import Beacon

db = BeaconDatabase(host='localhost', username='beacons', password='wibble', database='beacons')

# Define the URL of the CSV file
base_url = "https://beaconspot.uk/test/api/bsdl.php?band=%d"

# Define the Referer header
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://ukrepeater.net",
}

def update(band):
    url = base_url % band
    try:
        # Send an HTTP GET request to the URL with the Referer header
        response = requests.get(url, headers=headers)

        # Check if the request was successful (status code 200)
        if response.status_code == 200:
            csv_data = response.text
            csv_file = StringIO(csv_data)
            csv_reader = csv.DictReader(csv_file)
            data = []

            source=1
            for row in csv_reader:
                if(row['Band']== str(band)):
                    try:
                        beacon = Beacon(
                            band=row['Band'],
                            callsign=row['Beacon'],
                            frequency=row['Frequency'],
                            locator=row['Locator'],
                            location=row['Location'],
                            antenna=row['Antenna'],
                            heading=row['Heading'],
                            power=row['Power'],
                            status=('O' if row['Status'] == 'QRV' else 'X'),
                            date_last_spot=row['DateLastSpot']
                        )
                        data.append(beacon)
                    except Exception as e:
                        print(str(e))
                        print(row)
            print("Updating %d" % band)
            db.update_beacons(data,source,band)
        else:
            print(f"Failed to retrieve data. Status code: {response.status_code}")

    except requests.exceptions.RequestException as e:
        print(f"Request error: {e}")
    except Exception as e:
        print(f"An error occurred: {e}")
        traceback.print_exc()
        
for band in [40,50,70,144,432,1296,2320,5760,10368,24048]:
    update(band)    

db.disconnect()
