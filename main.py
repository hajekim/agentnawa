import dataclasses
import logging
import os
import secrets
import urllib.request

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from dotenv import load_dotenv
import google.auth.exceptions
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests

import config_store
import providers

# Load .env file
load_dotenv()

app = FastAPI()

# --- Google app-level login (GIS). Enabled only when OAUTH_CLIENT_ID is set; ----
# unset -> the gate is a no-op so local dev stays open. See _auth_gate below.
OAUTH_CLIENT_ID = os.getenv("OAUTH_CLIENT_ID", "").strip()
ALLOWED_DOMAINS = {d.strip().lower() for d in os.getenv("ALLOWED_DOMAINS", "").split(",") if d.strip()}
_PUBLIC_PATHS = {"/login", "/auth/callback", "/logout"}


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    """Require a signed-in session for everything but the login flow and static
    assets. Off (open) when OAUTH_CLIENT_ID is unset — local dev with no login."""
    if not OAUTH_CLIENT_ID:
        return await call_next(request)
    path = request.url.path
    if path in _PUBLIC_PATHS or path.startswith("/static/") or request.session.get("email"):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    return RedirectResponse("/login", status_code=302)


# SessionMiddleware added last => outermost => runs before the gate, so
# request.session is populated when the gate reads it.
_session_secret = os.getenv("SESSION_SECRET")
if not _session_secret:
    _session_secret = secrets.token_hex(32)
    if OAUTH_CLIENT_ID:
        logging.warning("SESSION_SECRET unset; using a random key — sessions reset on restart.")
app.add_middleware(
    SessionMiddleware, secret_key=_session_secret, same_site="lax",
    https_only=os.getenv("HTTPS_ONLY", "").lower() in ("1", "true", "yes"),
)

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")


def _public(agent) -> dict:
    d = dataclasses.asdict(agent)
    d.pop("raw", None)  # provider raw is server-side only
    return d


_runtime_sa_cache = "__unset__"  # sentinel; resolved once on first request


def _runtime_sa() -> "str | None":
    """Runtime service-account email from the GCE metadata server (Cloud Run).
    This is the identity a customer's org admin must allow through their VPC-SC
    ingress rule, so the UI surfaces it in the onboarding guide. Cached; returns
    None off-GCP (local dev) so the UI shows a fallback instead of erroring."""
    global _runtime_sa_cache
    if _runtime_sa_cache != "__unset__":
        return _runtime_sa_cache
    try:
        req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(req, timeout=1) as resp:
            _runtime_sa_cache = resp.read().decode().strip() or None
    except Exception:
        _runtime_sa_cache = None
    return _runtime_sa_cache


def _err_fields(e: Exception) -> dict:
    """Health-row fields for a failed connection. A VPC-SC denial gets an amber,
    actionable shape (it is an expected onboarding state, not an outage); every
    other error keeps the plain string with hint='' so the existing contract holds.
    """
    if isinstance(e, providers.VpcScDenied):
        return {
            "error": str(e),
            "error_type": "vpc_sc",
            "vpc_sc": {"service": e.service, "unique_id": e.unique_id,
                       "troubleshoot_token": e.troubleshoot_token},
            "hint": ("VPC Service Controls가 이 프로젝트를 차단하고 있습니다. 고객사 조직 관리자가 "
                     "인그레스 규칙에 우리 서비스 계정을 추가해야 합니다 (docs/vpc-sc-onboarding.md). "
                     "위반 분석기에서 uid로 확인하세요."),
        }
    return {"error": str(e), "error_type": "other", "hint": ""}


@app.get("/")
async def read_index():
    return FileResponse("static/index.html")


_LOGIN_HTML = """<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>로그인 — Agent Nawa</title>
<script src="https://accounts.google.com/gsi/client" async></script>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:'Outfit',system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
  .card{background:#1e293b;border:1px solid #334155;border-radius:.75rem;
    padding:2.5rem 3rem;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  .brand{font-size:1.4rem;font-weight:700;margin-bottom:.5rem}
  .card p{color:#94a3b8;font-size:.9rem;margin:.5rem 0 1.5rem}
  .g_id_signin{display:inline-block}
</style></head>
<body><div class="card">
  <div class="brand">🧩 Agent Nawa</div>
  <p>계속하려면 Google 계정으로 로그인하세요.</p>
  <div id="g_id_onload" data-client_id="__CLIENT_ID__" data-login_uri="__LOGIN_URI__"
       data-auto_prompt="false"></div>
  <div class="g_id_signin" data-type="standard" data-size="large"
       data-text="signin_with" data-shape="pill" data-theme="filled_blue"></div>
</div></body></html>"""


def _redirect_uri(request: Request) -> str:
    """Absolute /auth/callback URI. Uses BASE_URL if set (needed behind the Cloud
    Run proxy, where request scheme may be http); else derives from the request."""
    base = os.getenv("BASE_URL", "").strip().rstrip("/")
    return (base or str(request.base_url).rstrip("/")) + "/auth/callback"


def _verify_token(token: str) -> dict:
    """Verify a GIS ID token and return its claims. Isolated for test seams."""
    return google_id_token.verify_oauth2_token(token, google_requests.Request(), OAUTH_CLIENT_ID)


@app.get("/login")
async def login_page(request: Request):
    if request.session.get("email"):
        return RedirectResponse("/", status_code=302)
    html = _LOGIN_HTML.replace("__CLIENT_ID__", OAUTH_CLIENT_ID).replace(
        "__LOGIN_URI__", _redirect_uri(request))
    return HTMLResponse(html)


@app.post("/auth/callback")
async def auth_callback(request: Request):
    """GIS posts the ID token here. Verify CSRF (double-submit cookie), verify the
    token, enforce the domain allowlist, then set the session and redirect home."""
    form = await request.form()
    body_csrf = form.get("g_csrf_token")
    cookie_csrf = request.cookies.get("g_csrf_token")
    if not cookie_csrf or not body_csrf or cookie_csrf != body_csrf:
        raise HTTPException(status_code=400, detail="CSRF check failed")
    try:
        claims = _verify_token(form.get("credential") or "")
    except Exception:
        raise HTTPException(status_code=401, detail="invalid ID token")
    email = (claims.get("email") or "").lower()
    if not claims.get("email_verified") or not email:
        raise HTTPException(status_code=403, detail="email not verified")
    if ALLOWED_DOMAINS and email.split("@")[-1] not in ALLOWED_DOMAINS:
        raise HTTPException(status_code=403, detail="domain not allowed")
    request.session["email"] = email
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


@app.get("/api/me")
async def whoami(request: Request):
    return {"email": request.session.get("email"), "auth_enabled": bool(OAUTH_CLIENT_ID)}


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
            health.append({"name": p.name, "label": p.label, "status": "error", "count": 0, **_err_fields(e)})
    agents.sort(key=lambda a: a.created_at or "", reverse=True)
    return {"agents": [_public(a) for a in agents], "providers": health,
            "service_account": _runtime_sa()}


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
                           "count": 0, **_err_fields(e)})
    return {"projects": projects, "providers": health}


@app.get("/api/antigravity/metrics")
async def get_antigravity_metrics(days: int = 30):
    """Antigravity inference usage across connected gemini projects, read from the
    central BigQuery log sink. Project-scoped (connections sharing a project counted
    once); unconfigured or empty degrades to zeros, never 500."""
    days = max(1, min(days, 90))
    project_ids: list[str] = []
    seen: set[str] = set()
    for c in config_store.load():
        if (c.get("provider") or "gemini") != "gemini":
            continue
        pid = c.get("project_id")
        if pid and pid not in seen:
            seen.add(pid)
            project_ids.append(pid)
    configured = bool(os.getenv("CENTRAL_PROJECT") or os.getenv("ANTIGRAVITY_BQ_PROJECT"))
    try:
        usage = providers.list_antigravity_usage(project_ids, days)
        status, error = "ok", None
    except Exception as e:
        usage, status, error = providers._empty_usage(), "error", str(e)
    if not configured:
        message = "Antigravity BigQuery가 설정되지 않았습니다 (CENTRAL_PROJECT)."
    elif not error and usage["summary"]["total_inferences"] == 0:
        message = "선택한 기간에 Antigravity 로그가 없습니다."
    else:
        message = None
    health = [{"name": "antigravity", "label": "Antigravity", "status": status,
               "count": usage["summary"]["total_inferences"], "error": error}]
    return {**usage, "days": days, "message": message, "configured": configured, "providers": health}


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
    except providers.VpcScDenied as e:
        f = _err_fields(e)  # modal consumes error+hint only; skip the vpc_sc struct
        return {"ok": False, "error": f["error"], "hint": f["hint"]}
    except Exception as e:
        return {"ok": False, "error": str(e), "hint": ""}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
