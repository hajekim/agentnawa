terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 7.0" # iap_enabled on Cloud Run v2 + regional IAP IAM are 6.x
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
