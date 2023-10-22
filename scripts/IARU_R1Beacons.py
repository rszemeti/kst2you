import requests
from bs4 import BeautifulSoup
import re
import json

from BeaconDatabase import BeaconDatabase
from BeaconDatabase import Beacon

db = BeaconDatabase(host='localhost', username='beacons', password='wibble', database='beacons')

url = 'https://iaru-r1-vhfbeacons.org/index.php/beacon-db/'  # Replace with your URL

# Download the webpage
response = requests.get(url)
response.raise_for_status()  # Raise an error for failed requests

# Parse the webpage content with BeautifulSoup
soup = BeautifulSoup(response.content, 'html.parser')

# Find the script tag with the desired line
script_tag = None
for tag in soup.find_all('script'):
    if 'var items = new Array(' in tag.text:
        script_tag = tag.text
        break

if script_tag:
    # Extract the JSON data from the script tag
    match = re.search(r'var items = new Array\((.+?)\);', script_tag)
    if match:
        json_data_str = '[' + match.group(1) + ']'

        data=[]
        # Load the JSON data into a Python variable
        beacon_list = json.loads(json_data_str)
        for row in beacon_list:
            beacon = Beacon(row['Callsign'],
                            float(row['QRG'])/1000.0,
                            row['Locator'],
                            row['QTH'].replace('\r', ' ').replace('\n', ' '),
                            'O')
            data.append(beacon)

        print(data)
        db.update_beacons(data,2)
        
else:
    print("Couldn't find the desired script tag.")

db.disconnect()
