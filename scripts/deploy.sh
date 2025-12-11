#!/bin/bash

# Quick deployment script for K2U Checker to Google Cloud Run

set -e  # Exit on error

echo "K2U Spot Checker - Cloud Run Deployment"
echo "========================================"
echo ""

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "ERROR: config.json not found!"
    echo "Please copy config.json.example to config.json and configure it."
    exit 1
fi

# Get project ID
if [ -z "$PROJECT_ID" ]; then
    echo "Enter your Google Cloud Project ID:"
    read PROJECT_ID
fi

echo "Using project: $PROJECT_ID"
gcloud config set project $PROJECT_ID

# Enable APIs
echo ""
echo "Enabling required APIs..."
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com

# Deploy to Cloud Run
echo ""
echo "Deploying to Cloud Run..."
gcloud run deploy k2u-checker \
  --source . \
  --region europe-west2 \
  --platform managed \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 512Mi \
  --timeout 900s

# Get service URL
SERVICE_URL=$(gcloud run services describe k2u-checker \
  --region europe-west2 \
  --format 'value(status.url)')

echo ""
echo "Service deployed at: $SERVICE_URL"

# Ask about scheduler
echo ""
echo "Do you want to set up weekly scheduling? (y/n)"
read SETUP_SCHEDULER

if [ "$SETUP_SCHEDULER" = "y" ] || [ "$SETUP_SCHEDULER" = "Y" ]; then
    # Check if job already exists
    if gcloud scheduler jobs describe k2u-weekly-check --location=europe-west2 >/dev/null 2>&1; then
        echo "Scheduler job already exists. Updating..."
        gcloud scheduler jobs update http k2u-weekly-check \
          --uri="$SERVICE_URL" \
          --location=europe-west2
    else
        echo "Creating scheduler job (Monday 9am)..."
        gcloud scheduler jobs create http k2u-weekly-check \
          --schedule="0 9 * * 1" \
          --time-zone="Europe/London" \
          --uri="$SERVICE_URL" \
          --http-method=POST \
          --location=europe-west2 \
          --description="Weekly K2U spot checker"
    fi
    
    echo ""
    echo "✓ Deployment complete!"
    echo "✓ Scheduled to run every Monday at 9am"
    echo ""
    echo "Test it now with:"
    echo "  gcloud scheduler jobs run k2u-weekly-check --location=europe-west2"
else
    echo ""
    echo "✓ Deployment complete!"
    echo ""
    echo "To test manually:"
    echo "  curl -X POST $SERVICE_URL"
fi

echo ""
echo "View logs with:"
echo "  gcloud run logs read k2u-checker --region europe-west2"
