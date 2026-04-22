# Beacon Updater Cloud Setup

This project fetches beacon data from [beaconspot.uk](https://beaconspot.uk/), stores it in Firestore, generates a summary JSON file, and uploads it to a Cloud Storage bucket. It is triggered via Pub/Sub and scheduled to run every 12 hours.

---

## 🔧 Google Cloud Components

### ✅ Services Used

* **Cloud Functions**
* **Pub/Sub** (Topic: `beacon-updater`)
* **Firestore** (Native mode)
* **Cloud Storage** (Bucket: `kst2you`)
* **Cloud Scheduler**

---

##  Cloud Function

### Function Details

* **Name**: `update_beacons`
* **Runtime**: `Python 3.11`
* **Trigger**: Pub/Sub
* **Topic**: `beacon-updater`
* **Entry Point**: `main`
* **Region**: (e.g., `europe-west1`)

### Required Python Packages (`requirements.txt`)

```txt
google-cloud-firestore
google-cloud-storage
requests
```

---

## 🛠 Setup Instructions

### 1. Enable Required APIs

In the Cloud Console or via CLI:

```
gcloud services enable \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com
```

---

### 2. Create Firestore Database

* Go to [Firestore](https://console.cloud.google.com/firestore)
* Click **Create Database**
* Choose **Native mode**

---

### 3. Create Pub/Sub Topic

* Go to [Pub/Sub Topics](https://console.cloud.google.com/cloudpubsub/topic/list)
* Click **Create Topic**
* Name it: `beacon-updater`

---

### 4. Create Cloud Storage Bucket

* Go to [Cloud Storage](https://console.cloud.google.com/storage)
* Click **Create Bucket**
* Name it: `kst2you`
* Choose your region and storage class

---

### 5. Deploy Cloud Function

In Cloud Console:

* Go to [Cloud Functions](https://console.cloud.google.com/functions)
* Click **Create Function**
* Use:

  * Environment: **2nd gen**
  * Runtime: `Python 3.11`
  * Entry Point: `main`
  * Trigger: **Pub/Sub**, topic: `beacon-updater`
* Paste the code in the inline editor
* Add the `requirements.txt`
* Deploy

---

### 6. Create Cloud Scheduler Job

* Go to [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler)
* Click **Create Job**
* Name: `beacon-updater-job`
* Frequency: `0 */12 * * *` (every 12 hours)
* Time zone: (e.g., `Europe/London`)
* Target: **Pub/Sub**
* Topic: `beacon-updater`
* Message body:

  ```json
  {}
  ```

---

## 🔪 Manually Trigger the Function

1. Go to [Pub/Sub Topics](https://console.cloud.google.com/cloudpubsub/topic/list)
2. Click `beacon-updater`
3. Click **“Publish Message”**
4. Use an empty or simple message:

   ```json
   {}
   ```

---

## 📂 Output

* Firestore: Collection `beacons`, documents like `144_GB3VHF`
* Cloud Storage: File `BeaconList.json` uploaded to bucket `kst2you`

  * Optional: Use timestamped filenames like `beacons-YYYY-MM-DD.json`

---

## 📓 Notes

* Make sure the Cloud Function's service account has these roles:

  * Firestore: `Cloud Datastore User`
  * Storage: `Storage Object Creator`

* Function must use `def main(event, context)` for Pub/Sub

---

## ✅ Example Success Log

```
Fetching band 144
Fetched 8 beacons for band 144
Uploaded JSON summary to gs://kst2you/BeaconList.json
Beacon update complete
```

---

## Live Backend Smoke Tests

The unit tests under `scripts/tests/test_cloud_backends.py` use an in-memory fake Firestore client and do not hit the deployed Cloud Run services.

To run an opt-in smoke test against the live backends, use `scripts/tests/test_cloud_backends_live.py` with a throwaway namespace key:

```powershell
$env:RUN_LIVE_CLOUD_TESTS = '1'
python -m unittest scripts.tests.test_cloud_backends_live
```

Optional environment overrides:

```powershell
$env:LIVE_CONTEST_LOG_URL = 'https://your-contest-service.run.app/'
$env:LIVE_USER_SETTINGS_URL = 'https://your-user-settings-service.run.app/'
```

These tests create temporary remote data and delete it during teardown.

---

## DX Cluster Spot Injector

The repository now includes a standalone HTTP backend in `dx_cluster_cloud.py` for posting spots directly to a DX cluster over TCP/Telnet.

### Why This Exists

The browser currently injects spots by sending a `/DX ...` command through the active KST session. That only works while the user is connected to KST. A server-side injector allows KST2You to post straight to a cluster endpoint without depending on the KST chat transport.

### Function Details

* **Name**: `dx-cluster-spot`
* **Runtime**: `Python 3.11`
* **Trigger**: HTTP
* **Entry Point**: `main`
* **Region**: (e.g. `europe-west1`)

### Required Python Packages

Use `dx_cluster_requirements.txt`:

```txt
functions-framework==3.*
```

### Supported Request

POST JSON with `action: "sendSpot"`:

```json
{
  "action": "sendSpot",
  "data": {
    "auth": {
      "login": "G1ABC",
      "password": "app-password"
    },
    "spot": {
      "callsign": "DL0ABC",
      "freq": "144300.0",
      "report": "599",
      "spotter_locator": "IO91",
      "mode": "TR",
      "locator": "JO50",
      "comment": "K2U"
    }
  }
}
```

The service validates `auth.login` and `auth.password` against the salted PBKDF2 hash stored in the `user_settings` Firestore collection. After that succeeds, it logs into the DX cluster using a DXSpider-safe base callsign derived from the authenticated login. For example, `G1ABC/P`, `G1ABC-2`, and `G1ABC_2` are normalized to `G1ABC` for the cluster session. Most clusters do not require a second password, so cluster password is optional and only used if the target cluster explicitly prompts for one.

The request must not include cluster connection details. Host, port, prompts, and any optional cluster-side password are deployment settings supplied through environment variables only.

That produces a cluster command like:

```txt
DX 144300.0 DL0ABC 599 IO91<TR>JO50 K2U
```

You can also pass `data.spotCommand` directly if the caller wants full control over the exact command string.

### Environment Variables

Cluster settings are provided at deploy time:

```txt
DX_CLUSTER_HOST
DX_CLUSTER_PORT
DX_CLUSTER_USERNAME
DX_CLUSTER_PASSWORD
DX_CLUSTER_TIMEOUT_SECONDS
DX_CLUSTER_CONNECT_TIMEOUT_SECONDS
DX_CLUSTER_POST_LOGIN_DELAY_SECONDS
DX_CLUSTER_LOGIN_PROMPTS
DX_CLUSTER_PASSWORD_PROMPTS
DX_CLUSTER_READY_PROMPTS
DX_CLUSTER_QUIT_COMMAND
DX_CLUSTER_DEFAULT_COMMENT
KST_ADMIN_CALLSIGNS
```

For production, prefer Secret Manager-backed environment variables for any cluster-side password. The caller's `auth.password` should be transmitted only over HTTPS and must never be stored in browser local storage.

`KST_ADMIN_CALLSIGNS` is a comma-separated server-side allowlist of base callsigns that should have admin access, for example `G1YFG,G4ABC`. Admin status should not be stored in user-editable settings documents.

### Local Smoke Test

```powershell
python -m unittest scripts.tests.test_dx_cluster_cloud
```

### Deployment Sketch

```powershell
gcloud functions deploy dx-cluster-spot `
  --gen2 `
  --runtime=python311 `
  --region=europe-west1 `
  --source=scripts `
  --entry-point=main `
  --trigger-http `
  --allow-unauthenticated
```

If you deploy from the `scripts` directory, rename `dx_cluster_requirements.txt` to `requirements.txt` for that deployment package, or deploy from a dedicated folder containing `dx_cluster_cloud.py` and `requirements.txt`.
