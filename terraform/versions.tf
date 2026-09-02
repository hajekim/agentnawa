terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 8.0" # iap_enabled on google_cloud_run_v2_service lands in 7.x
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
