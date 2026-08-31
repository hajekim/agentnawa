output "service_uri" {
  description = "HTTPS URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.svc.uri
}

output "service_account_email" {
  description = "Runtime service account; grant it access in each connected project."
  value       = google_service_account.svc.email
}
