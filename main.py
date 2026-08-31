import dataclasses
import secrets

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv
import google.auth.exceptions

import config_store
import providers

# Load .env file
load_dotenv()

app = FastAPI()

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")


def _public(agent) -> dict:
    d = dataclasses.asdict(agent)
    d.pop("raw", None)  # provider raw is server-side only
    return d


@app.get("/")
async def read_index():
    return FileResponse("static/index.html")


@app.get("/api/agents")
async def get_agents():
    """Fan out to every provider; one provider failing degrades to N-1, never 500."""
    agents = []
    health = []
    for p in providers.registry():  # rebuilt per request so connection edits take effect live
        try:
            items = p.list_agents()
            agents.extend(items)
            health.append({"name": p.name, "label": p.label, "status": "ok", "count": len(items), "error": None})
        except Exception as e:
            health.append({"name": p.name, "label": p.label, "status": "error", "count": 0, "error": str(e)})
    agents.sort(key=lambda a: a.created_at or "", reverse=True)
    return {"agents": [_public(a) for a in agents], "providers": health}


@app.get("/api/connections")
async def list_connections():
    return {"connections": config_store.load()}


@app.post("/api/connections", status_code=201)
async def create_connection(body: dict):
    project_id = (body.get("project_id") or "").strip()
    app_id = (body.get("app_id") or "").strip()
    if not project_id or not app_id:
        raise HTTPException(status_code=400, detail="project_id and app_id are required")
    conn = {
        "id": secrets.token_hex(4),
        "project_id": project_id,
        "app_id": app_id,
        "cid": (body.get("cid") or "").strip(),
        "label": (body.get("label") or "").strip(),
    }
    conns = config_store.load()
    conns.append(conn)
    config_store.save(conns)
    return conn


@app.put("/api/connections/{conn_id}")
async def update_connection(conn_id: str, body: dict):
    project_id = (body.get("project_id") or "").strip()
    app_id = (body.get("app_id") or "").strip()
    if not project_id or not app_id:
        raise HTTPException(status_code=400, detail="project_id and app_id are required")
    conns = config_store.load()
    for c in conns:
        if c.get("id") == conn_id:
            c["project_id"] = project_id
            c["app_id"] = app_id
            c["cid"] = (body.get("cid") or "").strip()
            c["label"] = (body.get("label") or "").strip()
            config_store.save(conns)
            return c
    raise HTTPException(status_code=404, detail="connection not found")


@app.delete("/api/connections/{conn_id}")
async def delete_connection(conn_id: str):
    conns = config_store.load()
    remaining = [c for c in conns if c.get("id") != conn_id]
    if len(remaining) == len(conns):
        raise HTTPException(status_code=404, detail="connection not found")
    config_store.save(remaining)
    return {"ok": True}


@app.post("/api/connections/test")
async def test_connection(body: dict):
    """Transient probe: build a throwaway provider and try one list call. Never 500."""
    p = providers.GeminiProvider(
        (body.get("project_id") or "").strip(),
        (body.get("app_id") or "").strip(),
        (body.get("cid") or "").strip(),
        name="gemini:test", label="test",
    )
    try:
        return {"ok": True, "agent_count": len(p.list_agents())}
    except (google.auth.exceptions.DefaultCredentialsError, google.auth.exceptions.RefreshError) as e:
        return {"ok": False, "error": str(e), "hint": "Run: gcloud auth application-default login"}
    except Exception as e:
        return {"ok": False, "error": str(e), "hint": ""}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
