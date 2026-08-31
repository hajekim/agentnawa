locals {
  config_bucket = var.config_bucket_name != "" ? var.config_bucket_name : "${var.project_id}-${var.service_name}-config"

  # APIs to enable on the host project. iap only when IAP is turned on.
  base_services = [
    "run.googleapis.com",
    "discoveryengine.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
  services = var.enable_iap ? concat(local.base_services, ["iap.googleapis.com"]) : local.base_services

  # The service account reads Gemini agents from the host project plus every
  # connected project, so it needs both roles in each. setproduct keeps the
  # for_each key stable (project:role) regardless of list order.
  agent_projects = toset(concat([var.project_id], var.connected_project_ids))
  project_roles  = ["roles/discoveryengine.viewer", "roles/serviceusage.serviceUsageConsumer"]
  project_role_bindings = {
    for pair in setproduct(local.agent_projects, local.project_roles) :
    "${pair[0]}:${pair[1]}" => { project = pair[0], role = pair[1] }
  }
}

# (a) Required APIs.
resource "google_project_service" "enabled" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# (b) Artifact Registry repo the admin pushes the image to (see terraform/README.md).
resource "google_artifact_registry_repository" "repo" {
  project       = var.project_id
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"
  description   = "Container images for ${var.service_name}."

  depends_on = [google_project_service.enabled]
}

# (c) Config store: one JSON blob (connections.json) lives here.
resource "google_storage_bucket" "config" {
  project                     = var.project_id
  name                        = local.config_bucket
  location                    = var.region
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}

# (d) Dedicated runtime service account.
resource "google_service_account" "svc" {
  project      = var.project_id
  account_id   = var.service_name
  display_name = "Agent Nawa Cloud Run service account"

  depends_on = [google_project_service.enabled]
}

# (e) IAM. Read Gemini agents on the host + every connected project...
resource "google_project_iam_member" "agent_access" {
  for_each = local.project_role_bindings
  project  = each.value.project
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.svc.email}"
}

# ...and read/write its config blob in the bucket.
resource "google_storage_bucket_iam_member" "config_admin" {
  bucket = google_storage_bucket.config.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.svc.email}"
}

# (f) The service. Runs as the SA above; auth to Google APIs is host ADC.
resource "google_cloud_run_v2_service" "svc" {
  project  = var.project_id
  name     = var.service_name
  location = var.region

  deletion_protection = false # eval-friendly teardown; set true (or drop) for prod

  # Network ingress. Default (IAP off) restricts to internal + Cloud Load
  # Balancing traffic. With IAP on, IAP authenticates every request at the edge,
  # so ingress must accept it; IAP + IAM are then the access control.
  ingress = var.enable_iap ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.svc.email

    containers {
      image = var.image

      # PORT is injected by Cloud Run; the container CMD reads ${PORT:-8080}.
      env {
        name  = "CONFIG_BUCKET"
        value = google_storage_bucket.config.name
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_project_iam_member.agent_access,
    google_storage_bucket_iam_member.config_admin,
  ]
}

# (g) Who may invoke the service directly (authenticated, non-IAP path).
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invoker_members)
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.svc.name
  role     = "roles/run.invoker"
  member   = each.value
}

# (h) IAP access. Grants the listed members access through IAP. Off by default
# so a bare `terraform apply` works for evaluation. Turning IAP on for the
# service, plus its OAuth brand / consent-screen, is a one-time manual step in
# the console (the stable provider has no field for it); do that before setting
# enable_iap = true, otherwise this binding has nothing to attach to.
resource "google_iap_web_cloud_run_service_iam_member" "iap_accessor" {
  for_each               = var.enable_iap ? toset(var.invoker_members) : toset([])
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.svc.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value

  depends_on = [google_project_service.enabled]
}
