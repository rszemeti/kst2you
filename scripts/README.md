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
