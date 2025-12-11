# K2U Spot Checker - Cloud Run Deployment

This script checks K2U spots against DX cluster data and sends email reports.

## Prerequisites

1. Google Cloud account with billing enabled
2. gcloud CLI installed and authenticated
3. Your `config.json` file configured with credentials

## Setup

### 1. Configure your settings

Copy `config.json.example` to `config.json` and fill in your details:
```bash
cp config.json.example config.json
# Edit config.json with your callsign and email settings
```

**Important**: Update `Audit.py` configuration:
- Set `TEST_MODE = False` (to connect to real cluster)
- Set `SEND_EMAIL = True` (to receive reports)

### 2. Deploy to Cloud Run

```bash
# Set your project ID
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Enable required APIs (first time only)
gcloud services enable run.googleapis.com
gcloud services enable cloudscheduler.googleapis.com

# Deploy to Cloud Run
gcloud run deploy k2u-checker \
  --source . \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 512Mi \
  --timeout 900s \
  --set-env-vars TEST_MODE=false
```

### 3. Set up weekly schedule

```bash
# Get the Cloud Run service URL
SERVICE_URL=$(gcloud run services describe k2u-checker \
  --region europe-west2 \
  --format 'value(status.url)')

# Create Cloud Scheduler job (runs every Monday at 9am)
gcloud scheduler jobs create http k2u-weekly-check \
  --schedule="0 9 * * 1" \
  --time-zone="Europe/London" \
  --uri="$SERVICE_URL" \
  --http-method=POST \
  --location=europe-west2 \
  --description="Weekly K2U spot checker"
```

### 4. Test the deployment

```bash
# Manually trigger the job
gcloud scheduler jobs run k2u-weekly-check \
  --location=europe-west2

# View logs
gcloud run logs read k2u-checker --region europe-west2 --limit 50
```

## Schedule Options

Change the `--schedule` parameter to run at different times:
- `"0 9 * * 1"` - Every Monday at 9am
- `"0 20 * * 5"` - Every Friday at 8pm
- `"0 12 * * 0"` - Every Sunday at noon
- `"0 9 * * *"` - Every day at 9am

## Cost

- Cloud Run: ~$0.00 for weekly runs (within free tier)
- Cloud Scheduler: ~$0.10/month
- **Total: ~$0.10/month**

## Viewing Results

- Check your email for the weekly report
- View logs: `gcloud run logs read k2u-checker --region europe-west2`
- View scheduled jobs: `gcloud scheduler jobs list --location=europe-west2`

## Updating

To update the script after changes:
```bash
gcloud run deploy k2u-checker \
  --source . \
  --region europe-west2
```

## Troubleshooting

**Test locally first:**
```bash
# Build and run locally
docker build -t k2u-checker .
docker run k2u-checker
```

**Check scheduler logs:**
```bash
gcloud scheduler jobs describe k2u-weekly-check \
  --location=europe-west2
```

**Manual trigger:**
```bash
# Trigger via URL
curl -X POST $SERVICE_URL
```

## Cleanup

To delete everything:
```bash
gcloud scheduler jobs delete k2u-weekly-check --location=europe-west2
gcloud run services delete k2u-checker --region europe-west2
```
