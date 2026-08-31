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

variable "config_bucket_name" {
  description = "Name of the GCS bucket holding connections.json. Empty computes \"PROJECT-agent-nawa-config\"."
  type        = string
  default     = ""
}
