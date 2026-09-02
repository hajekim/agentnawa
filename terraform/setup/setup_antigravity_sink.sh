#!/usr/bin/env bash
# One-time, org-admin setup for the Antigravity usage tab (Phase B).
#
# Creates the central BigQuery dataset and a Cloud Logging sink that routes
# `businessaicode.googleapis.com/inference_response` logs into it, then grants
# the sink's writer identity permission to write BigQuery. Run ONCE by someone
# with org/folder logging-admin + BigQuery-admin on the central project.
#
# This is NOT part of `terraform apply` (it touches org/folder-level logging and
# is billable). Terraform only grants the *runtime* SA read access (enable_antigravity).
#
# Usage:
#   CENTRAL_PROJECT=my-central-proj \
#   FOLDER_ID=123456789012 \            # optional: aggregate a whole folder
#   LOCATION=asia-northeast3 \          # BigQuery dataset location
#   ./setup_antigravity_sink.sh [CENTRAL_PROJECT]
set -euo pipefail

CENTRAL_PROJECT="${1:-${CENTRAL_PROJECT:-}}"
SINK_NAME="${SINK_NAME:-antigravity-inference-log-sink}"
BQ_DATASET_ID="${ANTIGRAVITY_BQ_DATASET:-antigravity_monitoring}"
FOLDER_ID="${FOLDER_ID:-}"
LOCATION="${LOCATION:-asia-northeast3}"

if [ -z "$CENTRAL_PROJECT" ]; then
  echo "Error: set CENTRAL_PROJECT (env or first arg)." >&2
  exit 1
fi

DESTINATION="bigquery.googleapis.com/projects/${CENTRAL_PROJECT}/datasets/${BQ_DATASET_ID}"
LOG_FILTER='logName:"logs/businessaicode.googleapis.com%2Finference_response"'

echo "Central project : ${CENTRAL_PROJECT}"
echo "Dataset         : ${CENTRAL_PROJECT}:${BQ_DATASET_ID} (${LOCATION})"
echo "Sink            : ${SINK_NAME}"
echo "Scope           : ${FOLDER_ID:+folder ${FOLDER_ID}}${FOLDER_ID:-project ${CENTRAL_PROJECT}}"
echo

# 1. Destination dataset in the central project (idempotent).
if bq show --dataset "${CENTRAL_PROJECT}:${BQ_DATASET_ID}" >/dev/null 2>&1; then
  echo "Dataset already exists."
else
  bq --location="${LOCATION}" mk -d \
    --description "Centralized Antigravity inference-response logs" \
    "${CENTRAL_PROJECT}:${BQ_DATASET_ID}"
fi

# 2. Log sink -> BigQuery. Folder-level (aggregated, --include-children) or a
#    single project. --use-partitioned-tables gives the modern schema our query
#    expects (jsonpayload_v1_inferenceresponselog.*, labels.*).
if [ -n "$FOLDER_ID" ]; then
  SCOPE_FLAG=(--folder="${FOLDER_ID}")
  if gcloud logging sinks describe "${SINK_NAME}" "${SCOPE_FLAG[@]}" >/dev/null 2>&1; then
    gcloud logging sinks update "${SINK_NAME}" "${DESTINATION}" "${SCOPE_FLAG[@]}" \
      --log-filter="${LOG_FILTER}" --use-partitioned-tables
  else
    gcloud logging sinks create "${SINK_NAME}" "${DESTINATION}" "${SCOPE_FLAG[@]}" \
      --include-children --log-filter="${LOG_FILTER}" --use-partitioned-tables \
      --description="Aggregates Antigravity inference logs across folder ${FOLDER_ID}"
  fi
else
  SCOPE_FLAG=(--project="${CENTRAL_PROJECT}")
  if gcloud logging sinks describe "${SINK_NAME}" "${SCOPE_FLAG[@]}" >/dev/null 2>&1; then
    gcloud logging sinks update "${SINK_NAME}" "${DESTINATION}" "${SCOPE_FLAG[@]}" \
      --log-filter="${LOG_FILTER}" --use-partitioned-tables
  else
    gcloud logging sinks create "${SINK_NAME}" "${DESTINATION}" "${SCOPE_FLAG[@]}" \
      --log-filter="${LOG_FILTER}" --use-partitioned-tables \
      --description="Routes Antigravity inference logs to BigQuery"
  fi
fi

# 3. Grant the sink's auto-created writer identity BigQuery write on the dataset's project.
WRITER_IDENTITY=$(gcloud logging sinks describe "${SINK_NAME}" "${SCOPE_FLAG[@]}" --format="value(writerIdentity)")
echo "Writer identity : ${WRITER_IDENTITY}"
for role in roles/bigquery.dataEditor roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "${CENTRAL_PROJECT}" \
    --member="${WRITER_IDENTITY}" --role="${role}" --condition=None >/dev/null
done

echo
echo "Done. Logs will append to:"
echo "  ${CENTRAL_PROJECT}.${BQ_DATASET_ID}.businessaicode_googleapis_com_inference_response"
echo "Set enable_antigravity=true (+ antigravity_bq_project=${CENTRAL_PROJECT}) in terraform, then apply."
