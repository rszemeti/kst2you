import requests
import json
import socket
import time
import threading
import smtplib
import csv
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from collections import defaultdict
from datetime import datetime, timedelta

# Configuration
# Load sensitive config from file if it exists
try:
    with open('config.json', 'r') as f:
        config = json.load(f)
        MY_CALLSIGN = config.get('MY_CALLSIGN', 'YOUR CALLSIGN')
        EMAIL_FROM = config.get('EMAIL_FROM', 'your_email@gmail.com')
        EMAIL_TO = config.get('EMAIL_TO', 'recipient@example.com')
        EMAIL_PASSWORD = config.get('EMAIL_PASSWORD', 'your_app_password')
        SMTP_SERVER = config.get('SMTP_SERVER', 'smtp.gmail.com')
        SMTP_PORT = config.get('SMTP_PORT', 587)
except FileNotFoundError:
    print("Warning: config.json not found, using default values")
    MY_CALLSIGN = "YOUR CALLSIGN"
    EMAIL_FROM = "your_email@gmail.com"
    EMAIL_TO = "recipient@example.com"
    EMAIL_PASSWORD = "your_app_password"
    SMTP_SERVER = "smtp.gmail.com"
    SMTP_PORT = 587

# API and cluster settings
API_URL = "https://europe-west2-kst-chat.cloudfunctions.net/kst-actions"
DX_CLUSTER_HOST = "dxcluster.f5len.org"
DX_CLUSTER_PORT = 7373
API_DAYS = 28
SPOTS_REQUEST_MULTIPLIER = 2  # Request double the spots from cluster
MIN_SPOTS_TO_SHOW = 10  # Minimum spots to request
TEST_MODE = False  # Set to True to read from test_data.txt instead of connecting to cluster
TEST_DATA_FILE = "test_data.txt"
SAVE_CLUSTER_DATA = True  # Set to True to save cluster results to test_data.txt

# Email Configuration
SEND_EMAIL = True  # Set to True to send results via email

class DXCluster:
    """
    Maintains a telnet connection to a DX cluster with background data reading.
    """
    def __init__(self, host, port):
        """
        Initialize DX cluster connection.
        
        Args:
            host (str): DX cluster hostname
            port (int): DX cluster port
        """
        self.host = host
        self.port = port
        self.sock = None
        self.connected = False
        self.buffer = ""
        self.buffer_lock = threading.Lock()
        self.reader_thread = None
        self.stop_reading = False
    
    def _background_reader(self):
        """
        Background thread that continuously reads data from the cluster.
        """
        while not self.stop_reading and self.connected:
            try:
                self.sock.settimeout(0.1)
                data = self.sock.recv(4096).decode('ascii', errors='ignore')
                if data:
                    with self.buffer_lock:
                        self.buffer += data
            except socket.timeout:
                continue
            except:
                break
    
    def connect(self, callsign):
        """
        Connect to the DX cluster and login.
        
        Args:
            callsign (str): Your callsign for login
        
        Returns:
            bool: True if connected successfully
        """
        try:
            print(f"Connecting to {self.host}:{self.port}...")
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((self.host, self.port))
            
            # Wait for login prompt
            self.sock.settimeout(5)
            response = ""
            while "login: " not in response:
                data = self.sock.recv(1024).decode('ascii', errors='ignore')
                response += data
            
            # Send callsign
            self.sock.send((callsign + "\n").encode('ascii'))
            print(f"Logged in as {callsign}")
            
            # Read welcome message
            time.sleep(1)
            self.sock.settimeout(1)
            try:
                welcome = self.sock.recv(4096).decode('ascii', errors='ignore')
                print(welcome)
            except socket.timeout:
                pass
            
            self.connected = True
            
            # Start background reader thread
            self.stop_reading = False
            self.reader_thread = threading.Thread(target=self._background_reader, daemon=True)
            self.reader_thread.start()
            
            return True
            
        except Exception as e:
            print(f"Connection error: {e}")
            self.connected = False
            return False
    
    def send_command(self, command):
        """
        Send a command to the cluster (non-blocking).
        
        Args:
            command (str): Command to send
        """
        if not self.connected:
            return
        
        try:
            self.sock.send((command + "\n").encode('ascii'))
        except Exception as e:
            print(f"Error sending command: {e}")
    
    def get_buffer(self):
        """
        Get and clear the current buffer contents.
        
        Returns:
            str: All accumulated data
        """
        with self.buffer_lock:
            data = self.buffer
            self.buffer = ""
            return data
    
    def read_spots(self, timeout=1):
        """
        Read any available spot data from the cluster.
        
        Args:
            timeout (float): How long to wait for data
        
        Returns:
            str: Any spot data received
        """
        if not self.connected:
            return None
        
        try:
            time.sleep(timeout)
            self.sock.settimeout(timeout)
            data = self.sock.recv(4096).decode('ascii', errors='ignore')
            return data
        except Exception as e:
            print(f"Error reading spots: {e}")
            return None
    
    def disconnect(self):
        """
        Disconnect from the cluster.
        """
        self.stop_reading = True
        if self.reader_thread:
            self.reader_thread.join(timeout=2)
        
        if self.sock:
            try:
                self.sock.send(b"bye\n")
                self.sock.close()
                print("Disconnected from cluster")
            except:
                pass
        self.connected = False

def get_spots(days=API_DAYS):
    """
    Fetch spots data from the KST actions API.
    
    Args:
        days (int): Number of days to retrieve data for (default: from config)
    
    Returns:
        dict: JSON response from the API
    """
    headers = {
        "Content-Type": "application/json"
    }
    
    payload = {
        "action": "getSpots",
        "data": {
            "days": days
        }
    }
    
    try:
        response = requests.post(API_URL, headers=headers, json=payload)
        response.raise_for_status()  # Raise an exception for bad status codes
        
        return response.json()
    
    except requests.exceptions.RequestException as e:
        print(f"Error making request: {e}")
        return None

def organize_by_spotter(spots_data):
    """
    Organize spots by spotter callsign.
    
    Args:
        spots_data (dict): Raw API response containing spots data
    
    Returns:
        dict: Dictionary with spotter callsigns as keys and arrays of their spots as values
    """
    if not spots_data or spots_data.get('status') != 'OK':
        return {}
    
    spots_by_spotter = defaultdict(list)
    
    for spot in spots_data.get('data', []):
        spotter_callsign = spot.get('spotter_callsign')
        if spotter_callsign:
            spots_by_spotter[spotter_callsign].append(spot)
    
    return dict(spots_by_spotter)

def parse_cluster_time(cluster_line):
    """
    Parse timestamp from cluster spot line.
    Example: "7-Dec-2025 2057Z"
    
    Args:
        cluster_line (str): Line from cluster data
    
    Returns:
        datetime or None: Parsed datetime or None if parsing fails
    """
    try:
        # Extract date pattern like "7-Dec-2025 2057Z"
        import re
        match = re.search(r'(\d+)-(\w+)-(\d+)\s+(\d+)Z', cluster_line)
        if match:
            day, month, year, time_str = match.groups()
            # Parse the time (HHMM format)
            hour = int(time_str[:2])
            minute = int(time_str[2:])
            # Construct datetime
            dt_str = f"{day}-{month}-{year} {hour:02d}:{minute:02d}"
            return datetime.strptime(dt_str, "%d-%b-%Y %H:%M")
    except:
        pass
    return None

def times_match(api_time_str, cluster_line, tolerance_before_seconds=60, tolerance_after_hours=1):
    """
    Check if API timestamp matches cluster timestamp within tolerance.
    Note: Cluster timestamps only have minute precision (seconds are always :00),
    so cluster time will typically appear up to 60 seconds BEFORE the actual API time.
    
    Args:
        api_time_str (str): ISO format timestamp from API
        cluster_line (str): Line from cluster containing timestamp
        tolerance_before_seconds (int): Seconds cluster can be BEFORE API time (default 60 for minute precision)
        tolerance_after_hours (int): Hours cluster can be AFTER API time (for propagation delay)
    
    Returns:
        bool: True if times match within tolerance
    """
    try:
        # Parse API time (ISO format with Z suffix)
        # Example: "2025-12-07T20:57:25.678Z"
        api_time = datetime.strptime(api_time_str.replace('Z', ''), "%Y-%m-%dT%H:%M:%S.%f")
        
        # Parse cluster time
        cluster_time = parse_cluster_time(cluster_line)
        
        if not cluster_time:
            # print(f"    DEBUG: Could not parse cluster time from: {cluster_line[:80]}")
            return False
        
        # Calculate time difference (cluster - api)
        # Since cluster has no seconds, it will be 0-59 seconds BEFORE the actual time
        time_diff_seconds = (cluster_time - api_time).total_seconds()
        
        # print(f"    DEBUG: API={api_time}, Cluster={cluster_time}, Diff={time_diff_seconds:.1f}s")
        
        # Cluster time should be between (api_time - 60 seconds) and (api_time + 1 hour)
        # Negative = cluster is before API (expected due to truncation)
        # Positive = cluster is after API (propagation delay)
        match = -tolerance_before_seconds <= time_diff_seconds <= (tolerance_after_hours * 3600)
        # print(f"    DEBUG: Match={match} (allowed range: -{tolerance_before_seconds}s to +{tolerance_after_hours*3600}s)")
        return match
        
    except Exception as e:
        # print(f"    DEBUG: Time parsing error: {e}")
        return False

def send_email_report(subject, body, attachments=None):
    """
    Send email report with results and optional attachments.
    
    Args:
        subject (str): Email subject
        body (str): Email body content
        attachments (list): List of file paths to attach
    
    Returns:
        bool: True if sent successfully
    """
    try:
        msg = MIMEMultipart()
        msg['From'] = EMAIL_FROM
        
        # Handle single recipient (string) or multiple recipients (list)
        if isinstance(EMAIL_TO, list):
            msg['To'] = ', '.join(EMAIL_TO)
            recipients = EMAIL_TO
        else:
            msg['To'] = EMAIL_TO
            recipients = [EMAIL_TO]
        
        msg['Subject'] = subject
        
        msg.attach(MIMEText(body, 'plain'))
        
        # Attach files if provided
        if attachments:
            for filepath in attachments:
                try:
                    with open(filepath, 'rb') as f:
                        part = MIMEBase('application', 'octet-stream')
                        part.set_payload(f.read())
                        encoders.encode_base64(part)
                        part.add_header('Content-Disposition', 
                                      f'attachment; filename={filepath.split("/")[-1]}')
                        msg.attach(part)
                except Exception as e:
                    print(f"Error attaching file {filepath}: {e}")
        
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        server.login(EMAIL_FROM, EMAIL_PASSWORD)
        
        server.send_message(msg)
        server.quit()
        
        print(f"Email sent successfully to {len(recipients)} recipient(s)")
        if attachments:
            print(f"  Attached {len(attachments)} file(s)")
        return True
        
    except Exception as e:
        print(f"Error sending email: {e}")
        return False

if __name__ == "__main__":
    # Fetch spots data for the last 7 days
    data = get_spots()
    
    if data:
        print("Successfully retrieved data")
        
        # Organize by spotter - returns dict with callsigns as keys, arrays of spots as values
        organized = organize_by_spotter(data)
        
        print(f"Total spots: {data.get('count', 0)}")
        print(f"Unique spotters: {len(organized)}")
        
        print("\nSpotter callsigns:")
        for spotter_call in organized.keys():
            print(f"  {spotter_call}")
        
    else:
        print("Failed to retrieve data")
        exit(1)
    
    # Connect to DX cluster and query each spotter (or use test data)
    print("\n" + "="*50)
    if TEST_MODE:
        print("TEST MODE - Reading from file")
    else:
        print("Connecting to DX Cluster")
    print("="*50)
    
    if TEST_MODE:
        # Read from test file
        try:
            print(f"Reading test data from {TEST_DATA_FILE}...")
            with open(TEST_DATA_FILE, 'r') as f:
                results = f.read()
            print("Test data loaded successfully")
        except FileNotFoundError:
            print(f"Error: {TEST_DATA_FILE} not found!")
            exit(1)
    else:
        # Connect to actual cluster
        cluster = DXCluster(DX_CLUSTER_HOST, DX_CLUSTER_PORT)
        if not cluster.connect(MY_CALLSIGN):
            print("Failed to connect to cluster")
            exit(1)
        
        try:
            # Clear any initial buffer
            time.sleep(2)
            cluster.get_buffer()
            
            # Fire off all queries
            print(f"\nSending queries for {len(organized)} spotters...")
            for spotter_call, spots in organized.items():
                # Calculate how many spots to request for this spotter
                spots_to_request = max(MIN_SPOTS_TO_SHOW, len(spots) * SPOTS_REQUEST_MULTIPLIER)
                print(f"  Querying {spotter_call} (requesting {spots_to_request} spots)...")
                cluster.send_command(f"show/dx {spots_to_request} by {spotter_call}")
                time.sleep(0.2)  # Small delay between sends
            
            # Wait for all results to come back
            print(f"\nWaiting 60 seconds for results to accumulate...")
            time.sleep(60)
            
            # Get all accumulated data
            results = cluster.get_buffer()
            
            # Optionally save to test file
            if SAVE_CLUSTER_DATA:
                try:
                    with open(TEST_DATA_FILE, 'w') as f:
                        f.write(results)
                    print(f"Cluster data saved to {TEST_DATA_FILE}")
                except Exception as e:
                    print(f"Error saving cluster data: {e}")
                
        except KeyboardInterrupt:
            print("\nStopping...")
            cluster.disconnect()
            exit(1)
        finally:
            cluster.disconnect()
    
    # Process results (same for both test and live mode)
    # Filter for only K2U spots
    print("\n" + "="*50)
    print("K2U Spots Found:")
    print("="*50)
    
    k2u_spots = []
    for line in results.split('\n'):
        if 'K2U' in line and not line.strip().startswith('G1YFG de'):
            k2u_spots.append(line)
            print(line)
    
    print(f"\nTotal K2U spots found: {len(k2u_spots)}")
    
    # Now iterate over spotters and try to match their spots with cluster data
    print("\n" + "="*50)
    print("Matching API spots with cluster data:")
    print("="*50)
    
    total_spots = 0
    total_found = 0
    matched_cluster_indices = set()  # Track which cluster spots have been matched
    detailed_report = ""  # Build detailed report for both console and email
    
    for spotter_call, spots in organized.items():
        spotter_report = f"\n{spotter_call} ({len(spots)} spots from API):\n"
        
        found_count = 0
        for spot in spots:
            total_spots += 1
            # Extract key fields from API spot
            callsign = spot.get('callsign')
            freq = spot.get('freq')  # This is an integer like 1296800
            spot_time = spot.get('date')
            
            # Look for this spot in the cluster data
            found = False
            matched_line = None
            for idx, cluster_line in enumerate(k2u_spots):
                # Skip if this cluster spot was already matched
                if idx in matched_cluster_indices:
                    continue
                    
                # Parse frequency from cluster line (e.g., "1296800.0")
                try:
                    cluster_freq_str = cluster_line.split()[0]
                    cluster_freq = int(float(cluster_freq_str))
                except:
                    continue
                
                # Check if:
                # 1. Frequency matches (as integers)
                # 2. Target callsign (GB3IOW) appears in the line
                # 3. Spotter callsign appears in angle brackets <G8IKP>
                # 4. Time matches within tolerance
                if (cluster_freq == freq and 
                    callsign in cluster_line and 
                    f"<{spotter_call}>" in cluster_line and
                    times_match(spot_time, cluster_line)):
                    found = True
                    matched_line = cluster_line.strip()
                    found_count += 1
                    total_found += 1
                    matched_cluster_indices.add(idx)  # Mark this cluster spot as matched
                    break
            
            if found:
                spotter_report += f"  ✓ FOUND: {callsign} on {freq} kHz at {spot_time}\n"
                spotter_report += f"    Cluster: {matched_line}\n"
            else:
                spotter_report += f"  ✗ NOT FOUND: {callsign} on {freq} kHz at {spot_time}\n"
        
        # Print spotter summary
        match_rate = (found_count / len(spots) * 100) if len(spots) > 0 else 0
        spotter_report += f"  Summary: {found_count}/{len(spots)} matched ({match_rate:.1f}%)\n"
        
        # Add to detailed report and print to console
        detailed_report += spotter_report
        print(spotter_report, end='')
    
    # Print overall summary
    print("\n" + "="*50)
    print("Overall Summary:")
    print("="*50)
    overall_rate = (total_found / total_spots * 100) if total_spots > 0 else 0
    print(f"Total spots from API: {total_spots}")
    print(f"Total spots matched: {total_found}")
    print(f"Match rate: {overall_rate:.1f}%")
    print(f"K2U spots in cluster data: {len(k2u_spots)}")
    print(f"Cluster spots matched (used): {len(matched_cluster_indices)}")
    print(f"Cluster spots unmatched: {len(k2u_spots) - len(matched_cluster_indices)}")
    
    # Send email if configured
    if SEND_EMAIL:
        print("\n" + "="*50)
        print("Sending Email Report")
        print("="*50)
        
        # Generate CSV files
        csv_files = []
        
        # 1. K2U API data CSV
        api_csv_file = "k2u_api_spots.csv"
        try:
            with open(api_csv_file, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(['Spotter', 'Callsign', 'Frequency', 'Locator', 'Mode', 'Report', 'Date', 'Timestamp', 'Matched'])
                
                for spotter_call, spots in organized.items():
                    for spot in spots:
                        # Check if this spot was matched
                        matched = any(
                            str(spot.get('freq')) in line and 
                            spot.get('callsign') in line and 
                            f"<{spotter_call}>" in line and
                            times_match(spot.get('date'), line)
                            for line in k2u_spots
                        )
                        
                        writer.writerow([
                            spot.get('spotter_callsign'),
                            spot.get('callsign'),
                            spot.get('freq'),
                            spot.get('locator'),
                            spot.get('mode'),
                            spot.get('report'),
                            spot.get('date'),
                            spot.get('timestamp'),
                            'Yes' if matched else 'No'
                        ])
            csv_files.append(api_csv_file)
            print(f"Generated {api_csv_file}")
        except Exception as e:
            print(f"Error generating API CSV: {e}")
        
        # 2. Cluster data text file
        cluster_txt_file = "cluster_spots.txt"
        try:
            with open(cluster_txt_file, 'w', encoding='utf-8') as f:
                f.write("K2U Spots from DX Cluster\n")
                f.write("="*80 + "\n\n")
                for line in k2u_spots:
                    f.write(line + "\n")
            csv_files.append(cluster_txt_file)
            print(f"Generated {cluster_txt_file}")
        except Exception as e:
            print(f"Error generating cluster file: {e}")
        
        # Build email body using cached detailed report
        email_body = f"""K2U Spot Matching Report
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

SUMMARY
=======
Total spots from API: {total_spots}
Total spots matched: {total_found}
Match rate: {overall_rate:.1f}%
K2U spots in cluster data: {len(k2u_spots)}

SPOTTER SUMMARY
===============
"""
        
        # Add per-spotter summary
        for spotter_call, spots in organized.items():
            spotter_found = sum(1 for spot in spots 
                              if any(f"<{spotter_call}>" in line and 
                                   str(spot.get('freq')) in line and
                                   spot.get('callsign') in line and
                                   times_match(spot.get('date'), line)
                                   for line in k2u_spots))
            match_rate = (spotter_found / len(spots) * 100) if len(spots) > 0 else 0
            email_body += f"{spotter_call}: {spotter_found}/{len(spots)} ({match_rate:.1f}%)\n"
        
        # Add the detailed report that was already generated
        email_body += f"""
DETAILED SPOT MATCHING
======================
{detailed_report}

ATTACHMENTS
===========
- k2u_api_spots.csv: All spots from K2U API with match status
- cluster_spots.txt: All K2U spots found in DX cluster
"""
        
        # Send the email with attachments
        subject = f"K2U Spot Report - {overall_rate:.1f}% match rate"
        send_email_report(subject, email_body, attachments=csv_files)
        
        # Clean up CSV files after sending
        for f in csv_files:
            try:
                import os
                os.remove(f)
            except:
                pass
