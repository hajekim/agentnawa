variable "project_id" {
  description = "GCP project that hosts the Agent Nawa service."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry, and the config bucket."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name; also used to name the SA and derived resources."
  type        = string
  default     = "agent-nawa"
}

variable "image" {
  description = "Container image URL the admin built and pushed (e.g. REGION-docker.pkg.dev/PROJECT/REPO/agent-nawa:TAG)."
  type        = string
}

variable "connected_project_ids" {
  description = "Projects whose Gemini Enterprise agents this instance may read; the service account is granted read access on each."
  type        = list(string)
  default     = []
}

variable "invoker_members" {
  description = "IAM members allowed to call the service (e.g. user:a@b.com, group:x@b.com). Empty means no one is granted run.invoker here."
  type        = list(string)
  default     = []
}

variable "enable_iap" {
  description = "Put the service behind Identity-Aware Proxy. Default off so a bare apply works for evaluation; the OAuth brand may need one-time manual setup."
  type        = bool
  default     = false
}

variable "ingress" {
  description = "Cloud Run ingress override. Empty keeps the default (INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER, or INGRESS_TRAFFIC_ALL when enable_iap). Set INGRESS_TRAFFIC_ALL for public + IAM-authenticated access without IAP."
  type        = string
  default     = ""
}

variable "config_bucket_name" {
  description = "Name of the GCS bucket holding connections.json. Empty computes \"PROJECT-agent-nawa-config\"."
  type        = string
  default     = ""
}

variable "enable_antigravity" {
  description = "Enable the Antigravity usage tab: grant the runtime SA read access to the central BigQuery inference-response dataset and pass its env vars. Requires the log sink from terraform/setup/setup_antigravity_sink.sh (org-admin, run once). Default off so a bare apply works for evaluation."
  type        = bool
  default     = false
}

variable "antigravity_bq_project" {
  description = "Project holding the central BigQuery inference-response dataset (CENTRAL_PROJECT). Required when enable_antigravity is true."
  type        = string
  default     = ""
}

variable "antigravity_bq_dataset" {
  description = "BigQuery dataset holding the businessaicode_googleapis_com_inference_response table."
  type        = string
  default     = "antigravity_monitoring"
}

variable "antigravity_bq_location" {
  description = "BigQuery location of the dataset (e.g. asia-northeast3). Empty lets the client resolve it."
  type        = string
  default     = ""
}
