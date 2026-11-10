# One-off setup for the kst-chat budget kill switch. Run from this folder in
# PowerShell. Steps 1-5 deploy it in DRY_RUN mode; step 6 tests it; step 7 arms it.

$P   = 'kst-chat'
$R   = 'europe-west2'
$SA  = "budget-kill-switch@$P.iam.gserviceaccount.com"
$RUNTIME_SA = '852912082756-compute@developer.gserviceaccount.com'

# 1. Topic the budget publishes to
gcloud pubsub topics create budget-kill-switch --project=$P

# 2. Service account with just enough rights: update Cloud Run services
#    (which needs actAs on their runtime account) and disable APIs
gcloud iam service-accounts create budget-kill-switch --project=$P --display-name="Budget kill switch"
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role=roles/run.developer --condition=None
gcloud projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role=roles/serviceusage.serviceUsageAdmin --condition=None
gcloud iam service-accounts add-iam-policy-binding $RUNTIME_SA --project=$P --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser

# 3. Deploy in dry-run mode
gcloud functions deploy budget-kill-switch --gen2 --region=$R --project=$P --runtime=nodejs22 --entry-point=killSwitch --trigger-topic=budget-kill-switch --source=. --run-service-account=$SA --trigger-service-account=$SA --max-instances=1 --ingress-settings=internal-only --no-allow-unauthenticated --set-env-vars=DRY_RUN=true

# 4. Let the trigger invoke it
gcloud functions add-invoker-policy-binding budget-kill-switch --region=$R --project=$P --member="serviceAccount:$SA"

# 5. GBP 15/month budget scoped to kst-chat only, publishing to the topic
gcloud billing budgets create --billing-account=007037-7391CE-29227B --billing-project=$P --display-name="kst-chat kill switch" --budget-amount=15GBP --filter-projects=projects/$P --threshold-rule=percent=1.0 --notifications-rule-pubsub-topic=projects/$P/topics/budget-kill-switch

# 6. Test with a fake over-budget message, then read the log after ~30s.
#    Expect "DRY_RUN: would PATCH ..." for each service and "would POST ... :disable".
gcloud pubsub topics publish budget-kill-switch --project=$P --message='{"budgetDisplayName":"test","costAmount":16,"budgetAmount":15,"currencyCode":"GBP","costIntervalStart":"2026-11-01T00:00:00Z"}'
# gcloud functions logs read budget-kill-switch --region=$R --project=$P --limit=20

# 7. Arm it (only after step 6 looks right)
# gcloud functions deploy budget-kill-switch --gen2 --region=$R --project=$P --runtime=nodejs22 --entry-point=killSwitch --trigger-topic=budget-kill-switch --source=. --update-env-vars=DRY_RUN=false

# ── Undo after it has fired ──────────────────────────────────────────────
# gcloud services enable maps-backend.googleapis.com elevation-backend.googleapis.com --project=kst-chat
# gcloud run services update kst-actions       --region=europe-west2 --project=kst-chat --ingress=all
# gcloud run services update beacon-updater    --region=europe-west2 --project=kst-chat --ingress=all
# gcloud run services update kst-contest-log   --region=europe-west1 --project=kst-chat --ingress=all
# gcloud run services update kst-user-settings --region=europe-west1 --project=kst-chat --ingress=all
# It fires again on the next budget message if spend is still >= GBP 15 that
# month, so raise the budget or set DRY_RUN=true before undoing mid-month.
