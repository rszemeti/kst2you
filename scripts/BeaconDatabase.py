import mysql.connector
from decimal import Decimal

class Beacon:
    def __init__(self, band, callsign, frequency, locator, location, antenna, heading, power, status, date_last_spot):
        self.band = band
        self.callsign = callsign
        self.frequency = float(frequency)
        self.locator = locator
        self.location = location
        self.antenna = antenna
        self.heading = heading
        self.power = float(power) if power else 0.0  # Convert empty string to 0.0
        self.status = status
        self.date_last_spot = date_last_spot

    def __str__(self):
        return f"Beacon(band={self.band}, callsign={self.callsign}, frequency={self.frequency}, locator={self.locator}, location={self.location}, antenna={self.antenna}, heading={self.heading}, power={self.power}, status={self.status}, date_last_spot={self.date_last_spot})"


class BeaconDatabase:
    def __init__(self, host, username, password, database):
        self.host = host
        self.username = username
        self.password = password
        self.database = database
        self.connection = None
        self.connect()

    def connect(self):
        try:
            self.connection = mysql.connector.connect(
                host=self.host,
                user=self.username,
                password=self.password,
                database=self.database
            )
            print("Connected to MySQL database")

        except mysql.connector.Error as err:
            print(f"Error: {err}")

    def disconnect(self):
        if self.connection:
            self.connection.close()
            print("Disconnected from MySQL database")

    def update_beacons(self,data,source,band):
        if not self.connection:
            print("Not connected to the database. Call 'connect()' first.")
            return

        try:
            cursor = self.connection.cursor()
            delete_query = "DELETE FROM beacons WHERE source=%s AND band=%s"
            cursor.execute(delete_query, (source,band))

            # Commit the DELETE operation
            self.connection.commit()
            
            insert_query = "INSERT INTO beacons (callsign,frequency,locator,comment,status,source,band) VALUES (%s, %s, %s,%s,%s,%s,%s)"
            for row in data:
                try:
                    cursor.execute(insert_query, (row.callsign,row.frequency,row.locator,row.location,row.status,source,row.band))
                except Exception as e:
                    print(f"Error: {e}")

            self.connection.commit()
            print("Data inserted successfully")
            
        except mysql.connector.Error as err:
            print(err)
            self.connection.rollback()
            print(f"Error: {err}")

        finally:
            cursor.close()

    def get_beacons(self,status="O"):
        cursor = self.connection.cursor()
        cursor.execute("SELECT * FROM beacons WHERE status='%s'" % status)
        rows = cursor.fetchall()
        data_list = []
        for row in rows:
            data_dict = {
                'callsign': row[0],  
                'frequency': float(row[1]),
                'locator': row[2],
                'comment': row[3],
                'status': row[4],
            }
            data_list.append(data_dict)
        return data_list

