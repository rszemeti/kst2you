import mysql.connector
from decimal import Decimal

class BeaconDatabase:
    def __init__(self, host, username, password, database):
        self.host = host
        self.username = username
        self.password = password
        self.database = database
        self.connection = None

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

    def update_beacons(self, data, prefix):
        if not self.connection:
            print("Not connected to the database. Call 'connect()' first.")
            return

        try:
            cursor = self.connection.cursor()
            delete_query = "DELETE FROM beacons WHERE callsign LIKE %s"

            # Create a wildcard pattern for the prefix with '%' appended
            wildcard_pattern = f"{prefix}%"

            # Execute the DELETE query with the wildcard pattern
            cursor.execute(delete_query, (wildcard_pattern,))

            # Commit the DELETE operation
            self.connection.commit()
            

            insert_query = "INSERT INTO beacons (callsign,frequency,locator,comment,status) VALUES (%s, %s, %s,%s,%s)"

            # Loop through the data array and insert each row into the table
            #0 ['GB3AAX',
            #1  '28.268000',
            #2  'IO95FF',
            #3  'ASHINGTON',
            #4  'VERTICAL',
            #5  '5',
            #6  'OMNI',
            #7  'H',
            #8  '1',
            #9  'F1D',
            #10 'NOT OPERATIONAL',
            #11 'G4NAB',
            #12 '']
            for row in data:
                cursor.execute(insert_query, (row[0], float(row[1]), row[2], row[3], 'O' if row[10] == 'OPERATIONAL' else 'X'))


            self.connection.commit()
            print("Data inserted successfully")
            
        except mysql.connector.Error as err:
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

