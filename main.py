import dataclasses

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

import providers

# Load .env file
load_dotenv()

app = FastAPI()

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Active providers, built once from environment
REGISTRY = providers.registry()


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
    for p in REGISTRY:
        try:
            items = p.list_agents()
            agents.extend(items)
            health.append({"name": p.name, "status": "ok", "count": len(items), "error": None})
        except Exception as e:
            health.append({"name": p.name, "status": "error", "count": 0, "error": str(e)})
    agents.sort(key=lambda a: a.created_at or "", reverse=True)
    return {"agents": [_public(a) for a in agents], "providers": health}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
