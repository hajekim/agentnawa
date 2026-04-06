# Agent Dashboard

This application lists Low Code agents created by users within the Gemini Enterprise Application that have been shared with the organization. Users can preview these agents and evaluate them (e.g., by liking them).

<img src="agent-dashbard.png" alt="Agent Dashboard" width="800">

## Local Running

1. Install dependencies:
   ```bash
   pip3 install -r requirements.txt
   ```
2. Run the server:
   ```bash
   python3 main.py
   ```
3. Access http://localhost:8000 in your browser.

## Deploy to Cloud Run

You can deploy this application directly to Cloud Run from source.

### Deployment Command

Run the following command in the project root:

```bash
export CID="your-client-id"
export PROJECT_ID="your-project-id"
export AS_APP="your-app-id"

gcloud run deploy agent-dashboard \
  --source . \
  --region us-central1 \
  --no-allow-unauthenticated --iap \
  --set-env-vars="CID=${CID},PROJECT_ID=${PROJECT_ID},AS_APP=${AS_APP}"

> [!NOTE]
> Since you are using IAP, the command above uses `--no-allow-unauthenticated`. IAP will handle authentication and pass the user's email in the `x-goog-authenticated-user-email` header.
```

> [!WARNING]
> This application uses a local SQLite database (`likes.db`) for tracking likes. When deployed to Cloud Run, data will be lost when the instance scales down to zero or restarts. For persistent storage, consider using Cloud SQL or another managed database.

### Environment Variables

Make sure to set these environment variables when deploying:
- `CID`: The Client ID for preview popup.
- `PROJECT_ID`: The Google Cloud Project ID.
- `AS_APP`: The Agent Space app ID.
