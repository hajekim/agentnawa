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


@app.get("/api/licenses")
async def get_licenses():
    """Gemini Enterprise license usage across configured connections. Project-scoped,
    so connections sharing a project_id are queried once (deduped); one project
    failing degrades to N-1, never 500."""
    seen: dict[str, str] = {}  # project_id -> connection label (first wins)
    for c in config_store.load():
        if (c.get("provider") or "gemini") != "gemini":
            continue
        pid = c.get("project_id")
        if pid and pid not in seen:
            seen[pid] = c.get("label") or "Gemini Enterprise"
    projects = []
    health = []
    for pid, label in seen.items():
        try:
            configs = providers.list_license_configs(pid)
            projects.extend({**cfg, "label": label} for cfg in configs)
            health.append({"name": f"gemini:{pid}", "label": label, "status": "ok",
                           "count": len(configs), "error": None})
        except Exception as e:
            health.append({"name": f"gemini:{pid}", "label": label, "status": "error",
                           "count": 0, "error": str(e)})
    return {"projects": projects, "providers": health}


def _normalized_conn(body: dict) -> dict:
    """Validate + normalize a connection body by provider. Raises 400 on missing fields."""
    provider = (body.get("provider") or "gemini").strip()
    project_id = (body.get("project_id") or "").strip()
    label = (body.get("label") or "").strip()
    if provider == "vertex":
        region = (body.get("region") or "").strip()
        if not project_id or not region:
            raise HTTPException(status_code=400, detail="project_id and region are required")
        return {"provider": "vertex", "project_id": project_id, "region": region, "label": label}
    app_id = (body.get("app_id") or "").strip()
    if not project_id or not app_id:
        raise HTTPException(status_code=400, detail="project_id and app_id are required")
    return {"provider": "gemini", "project_id": project_id, "app_id": app_id,
            "cid": (body.get("cid") or "").strip(), "label": label}


@app.get("/api/connections")
async def list_connections():
    return {"connections": config_store.load()}


@app.post("/api/connections", status_code=201)
async def create_connection(body: dict):
    conn = {"id": secrets.token_hex(4), **_normalized_conn(body)}
    conns = config_store.load()
    conns.append(conn)
    config_store.save(conns)
    return conn


@app.put("/api/connections/{conn_id}")
async def update_connection(conn_id: str, body: dict):
    fields = _normalized_conn(body)
    conns = config_store.load()
    for i, c in enumerate(conns):
        if c.get("id") == conn_id:
            conns[i] = {"id": conn_id, **fields}  # replace wholesale: provider may have changed
            config_store.save(conns)
            return conns[i]
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
    if (body.get("provider") or "gemini").strip() == "vertex":
        p = providers.VertexAgentEngineProvider(
            (body.get("project_id") or "").strip(),
            (body.get("region") or "").strip(),
            name="vertex:test", label="test",
        )
    else:
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
