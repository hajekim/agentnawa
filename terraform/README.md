# Agent Nawa — Terraform module

Provisions Agent Nawa on Cloud Run in your own GCP project: a dedicated service
account, a config bucket, an Artifact Registry repo, and the service itself,
with the IAM it needs to read Gemini Enterprise agents.

## Prerequisites

- `terraform` >= 1.5 and `gcloud`, authenticated (`gcloud auth login` and
  `gcloud auth application-default login`).
- A GCP project with billing enabled, and permission to enable APIs and grant
  IAM in it (roughly Owner, or Editor + Project IAM Admin).
- Docker, to build and push the image.

## 1. Create the Artifact Registry repo

The image must exist before Cloud Run can deploy it, so create just the repo first:

```bash
terraform init
terraform apply -target=google_artifact_registry_repository.repo \
  -var project_id=YOUR_PROJECT -var image=placeholder
```

## 2. Build and push the image

Run from the repo root (the directory with the `Dockerfile`):

```bash
REGION=us-central1
PROJECT=YOUR_PROJECT
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/agent-nawa/agent-nawa:v1"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker build -t "$IMAGE" ..
docker push "$IMAGE"
```

## 3. Apply

```bash
terraform apply \
  -var project_id="$PROJECT" \
  -var image="$IMAGE"
```

Outputs `service_uri` and `service_account_email`.

Ingress is restricted by default (`INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`), so
`service_uri` is not reachable from the public internet as-is. Reach it from
within the VPC, put it behind a load balancer, enable IAP (see below), or set
`-var ingress=INGRESS_TRAFFIC_ALL` for public + IAM-authenticated access.

## Variables worth setting

- `connected_project_ids` — other projects whose Gemini agents this instance may
  read. The service account is granted `discoveryengine.editor` and
  `serviceusage.serviceUsageConsumer` in each. (`editor`, not `viewer`: the
  v1alpha list-agents call returns an IAM 403 with only `viewer`.)
- `invoker_members` — who may call the service, e.g. `["group:agents@example.com"]`.
- `enable_iap` — front the service with Identity-Aware Proxy (default `false`).
- `ingress` — override Cloud Run ingress. Default is internal-only (or all when
  `enable_iap`); set `INGRESS_TRAFFIC_ALL` for public + IAM-authenticated access
  without IAP.
- `config_bucket_name` — override the default `PROJECT-agent-nawa-config`.
- `enable_antigravity` — turn on the usage tab (default `false`); see below.

## Granting cross-project access

For every project listed in `connected_project_ids`, that project's owner must
also enable the Discovery Engine API:

```bash
gcloud services enable discoveryengine.googleapis.com --project OTHER_PROJECT
```

Terraform grants the `service_account_email` output the reader roles in those
projects automatically. To add a project later, append it to
`connected_project_ids` and re-apply — the per-project IAM uses `for_each`, so
only the new bindings are added.

## Enabling the Antigravity usage tab

The usage tab reads a central BigQuery table fed by a Cloud Logging sink. Two
parts, split by who owns them:

1. **The log sink (org-admin, once).** It touches folder/org-level logging and is
   billable, so it is **not** part of `terraform apply`. Run
   [`setup/setup_antigravity_sink.sh`](setup/setup_antigravity_sink.sh) as someone
   with logging-admin on the folder/org and BigQuery-admin on the central project:

   ```bash
   CENTRAL_PROJECT=my-central-proj FOLDER_ID=123456789012 \
     ./setup/setup_antigravity_sink.sh
   ```

   It creates the dataset, the sink, and grants the sink's writer identity
   BigQuery write.

2. **Read access + env (this module).** Set `-var enable_antigravity=true -var
   antigravity_bq_project=my-central-proj`. Terraform enables the BigQuery API,
   grants the runtime service account **read-only** `bigquery.dataViewer` +
   `bigquery.jobUser` on that project, and injects `CENTRAL_PROJECT` /
   `ANTIGRAVITY_BQ_DATASET` / `ANTIGRAVITY_BQ_LOCATION` into the container.
   Optional: `antigravity_bq_dataset` (default `antigravity_monitoring`),
   `antigravity_bq_location`.

Left at the default (`false`), none of this is created and the tab shows a
"not configured" notice instead of erroring.

## Enabling IAP

Set `-var enable_iap=true`: Terraform sets `iap_enabled` on the service (IAP
with a Google-managed OAuth client — no manual OAuth brand / consent-screen),
grants `invoker_members` `roles/iap.httpsResourceAccessor`, and opens ingress so
IAP can reach the service. Left at the default (`false`), none of that is
created, so a bare apply stays clean for evaluation. Requires the google
provider 7.x (see `versions.tf`).
