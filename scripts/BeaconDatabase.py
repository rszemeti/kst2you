import mysql.connector
from decimal import Decimal

class Beacon:
    def __init__(self, callsign, frequency, locator, comment, status):
        self.callsign = callsign
        self.frequency = frequency
        self.locator = locator
        self.comment = comment
        self.status = status

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

    def update_beacons(self, data, source):
        if not self.connection:
            print("Not connected to the database. Call 'connect()' first.")
            return

        try:
            cursor = self.connection.cursor()
            delete_query = "DELETE FROM beacons WHERE source=%s"
            cursor.execute(delete_query, (source,))

            # Commit the DELETE operation
            self.connection.commit()
            
            insert_query = "INSERT INTO beacons (callsign,frequency,locator,comment,status,source) VALUES (%s, %s, %s,%s,%s,%s)"

            for row in data:
                try:
                    cursor.execute(insert_query, (row.callsign,row.frequency,row.locator,row.comment,row.status,source))
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

