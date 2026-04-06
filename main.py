from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import json
import os
import database
from dotenv import load_dotenv
import google.auth
import google.auth.transport.requests
import requests

# Load .env file
load_dotenv()

app = FastAPI()

# Initialize DB
database.init_db()

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

def get_adc_token():
    try:
        credentials, project = google.auth.default()
        if not credentials.valid:
            request = google.auth.transport.requests.Request()
            credentials.refresh(request)
        return credentials.token
    except Exception as e:
        print(f"Error getting ADC token: {e}")
        return None

@app.get("/")
async def read_index():
    return FileResponse("static/index.html")

@app.get("/api/config")
async def get_config():
    return {"cid": os.getenv("CID", "default_cid")}

@app.get("/api/agents")
async def get_agents():
    project_id = os.getenv("PROJECT_ID")
    as_app = os.getenv("AS_APP")
    
    if not project_id or not as_app:
        raise HTTPException(status_code=500, detail="PROJECT_ID or AS_APP not set in .env")
        
    token = get_adc_token()
    if not token:
        raise HTTPException(status_code=500, detail="Failed to get authentication token")

    url = f"https://discoveryengine.googleapis.com/v1alpha/projects/{project_id}/locations/global/collections/default_collection/engines/{as_app}/assistants/default_assistant/agents"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "x-goog-user-project": project_id
    }
    
    try:
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            if "agents" in data:
                data["agents"] = [
                    agent for agent in data["agents"]
                    if agent.get("lowCodeAgentDefinition") and agent.get("state") == "ENABLED"
                ]
            return data
        else:
            raise HTTPException(status_code=response.status_code, detail=response.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/likes")
async def get_likes(app_id: str):
    if not app_id:
        raise HTTPException(status_code=400, detail="app_id is required")
    return database.get_likes_count(app_id)

@app.post("/api/like")
async def like_agent(agent_id: str, app_id: str, x_goog_authenticated_user_email: str = Header(None)):
    # Fallback for local testing
    user_email = x_goog_authenticated_user_email
    if not user_email:
        user_email = "user1@exaple.com" # Mock user
        
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")
    if not app_id:
        raise HTTPException(status_code=400, detail="app_id is required")
        
    success = database.add_like(user_email, app_id, agent_id)
    if success:
        return {"status": "success"}
    else:
        raise HTTPException(status_code=400, detail="좋아요에 이미 참여하셨습니다.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
