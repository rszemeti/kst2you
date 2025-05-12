import telnetlib
import time

HOST = "dxcluster.f5len.org"
PORT = 7373
LOGFILE = "dx_log.txt"

def connect_to_dx_cluster(host, port):
    """Connect to a DX Cluster via Telnet, filter and log the output. Return True if disconnected unexpectedly."""
    try:
        # Connect to the DX Cluster
        telnet = telnetlib.Telnet(host, port, timeout=10)
        print(f"Connected to {host}:{port}")

        # Login process
        telnet.read_until(b"login: ")  # Wait for the login prompt
        telnet.write(b"G1YFG\n")  # Send your callsign

        while True:
            # Read and print data
            data = telnet.read_until(b"\n", timeout=10).decode('utf-8')
            if data:
                print(data.strip())
                if "k2u" in data.lower():
                    with open(LOGFILE, 'a') as log:
                        log.write(data + "\n")
            time.sleep(0.5)

    except KeyboardInterrupt:
        print("\nDisconnecting...")
        return False  # User-initiated exit
    except Exception as e:
        print(f"Error: {e}")
        return True  # Unexpected exit
    finally:
        telnet.close()

if __name__ == "__main__":
    while True:
        unexpected_exit = connect_to_dx_cluster(HOST, PORT)
        if unexpected_exit:
            print("Unexpected disconnection. Attempting to reconnect in 5 seconds...")
            time.sleep(5)
        else:
            break  # Exit loop if disconnected intentionally (e.g., KeyboardInterrupt)
