"""Agent providers: one thin adapter per platform.

Each provider owns its own base URL, auth, pagination, response parsing, and
open_url computation, and emits the normalized `Agent` shape the UI renders.
Add a platform by writing a new provider class and registering it in registry().
"""
import dataclasses
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Protocol

import google.auth
import google.auth.transport.requests
import requests

import config_store


@dataclasses.dataclass(frozen=True)
class Agent:
    id: str            # global, namespaced: f"{provider}:{native_id}"
    provider: str      # internal key: "gemini" | "m365" | "custom" | ...
    provider_label: str  # human product name shown as "Source", e.g. "Gemini Enterprise"
    display_name: str
    description: str
    type: str          # normalized kind (open set): "High Code" | "Low/No Code" | "A2A" | ...
    state: str
    icon: str | None
    created_at: str | None
    open_url: str | None  # server-computed human deep link (null when a type has none)
    raw: dict          # untouched provider record; new fields land here without a schema change


class AgentProvider(Protocol):
    name: str    # internal key (id namespace, health)
    label: str   # human product name shown to users

    def list_agents(self) -> list[Agent]:
        ...


# Gemini *Definition key -> normalized type label. Live deployments return
# undocumented types beyond the 4 in the public schema, so unknown keys are
# preserved rather than dropped (see _gemini_type).
_GEMINI_TYPES = {
    "adkAgentDefinition": "High Code",
    "lowCodeAgentDefinition": "Low/No Code",
    "agentDesignerAgentDefinition": "Low/No Code",
    "a2aAgentDefinition": "A2A",
    "workflowAgentDefinition": "Workflow",
    "skillAgentDefinition": "Skill",
    "managedAgentDefinition": "Managed",
}


def _gemini_type(agent: dict) -> str:
    for key, label in _GEMINI_TYPES.items():
        if key in agent:
            return label
    for key in agent:  # undocumented type: derive a label from the raw key
        if key.endswith("AgentDefinition"):
            return key[: -len("AgentDefinition")]
    return "Unknown"


def _icon_uri(icon) -> str | None:
    if isinstance(icon, dict):
        return icon.get("uri")
    return icon or None


def _adc_token() -> str:
    credentials, _ = google.auth.default()
    if not credentials.valid:
        credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token


class VpcScDenied(Exception):
    """A 403 whose body is a VPC Service Controls perimeter denial (not plain IAM).

    Carries the fields a customer's org admin needs to let us through and to
    diagnose in the Violation Analyzer: the target service, the unique id, and the
    troubleshoot token. Subclasses Exception so the existing per-connection
    handlers catch it and degrade to N-1 rather than 500.
    """

    def __init__(self, service: str, unique_id: str, troubleshoot_token: str):
        self.service = service
        self.unique_id = unique_id
        self.troubleshoot_token = troubleshoot_token
        super().__init__(
            f"VPC Service Controls가 {service or 'API'} 접근을 차단했습니다 (uid: {unique_id})"
        )


def _vpc_sc_denied(resp) -> "VpcScDenied | None":
    """Return a VpcScDenied if a 403 body is a VPC-SC perimeter denial, else None.

    A VPC-SC denial and a plain IAM PERMISSION_DENIED share the same 403 status,
    so we key strictly on the two independent signals Google emits: a
    PreconditionFailure violation of type VPC_SERVICE_CONTROLS, or an ErrorInfo
    reason of SECURITY_POLICY_VIOLATED (whose metadata carries service/uid/token).
    A non-JSON body (e.g. HTML from an intermediary proxy) returns None so the
    caller falls through to raise_for_status and keeps today's HTTPError.
    """
    try:
        details = resp.json().get("error", {}).get("details", [])
    except ValueError:
        return None
    is_vpc_sc = False
    meta: dict = {}
    for d in details:
        if any(v.get("type") == "VPC_SERVICE_CONTROLS" for v in d.get("violations", [])):
            is_vpc_sc = True
        if d.get("reason") == "SECURITY_POLICY_VIOLATED":
            is_vpc_sc = True
            meta = d.get("metadata", {}) or {}
    if not is_vpc_sc:
        return None
    return VpcScDenied(
        service=meta.get("service", ""),
        unique_id=meta.get("uid", ""),
        troubleshoot_token=meta.get("troubleshootToken", ""),
    )


def _http_get(url: str, headers: dict, params: dict) -> dict:
    for attempt in range(3):
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        if resp.status_code in (429, 503) and attempt < 2:
            time.sleep(float(resp.headers.get("Retry-After", 1)))
            continue
        if resp.status_code == 403:
            denied = _vpc_sc_denied(resp)
            if denied:
                raise denied
        resp.raise_for_status()
        return resp.json()
    return {}


class GeminiProvider:
    """Google Gemini Enterprise (Discovery Engine) agents for one Gemini Enterprise app."""

    def __init__(self, project_id: str, as_app: str, cid: str | None, name: str, label: str):
        self.project_id = project_id
        self.as_app = as_app
        self.cid = cid
        self.name = name    # unique per-connection health id, e.g. "gemini:<conn_id>"
        self.label = label  # connection label, or "Gemini Enterprise" default

    def _open_url(self, native_id: str) -> str | None:
        if not self.cid:
            return None
        agent_id = native_id.split("/")[-1]
        # ponytail: Vertex assistant deep link verified for lowCode only; reused for
        # all types as the best available launch URL. Revisit per-type if any 404s.
        return f"https://vertexaisearch.cloud.google.com/home/cid/{self.cid}/r/agent/{agent_id}/session/-"

    def list_agents(self) -> list[Agent]:
        token = _adc_token()
        url = (
            f"https://discoveryengine.googleapis.com/v1alpha/projects/{self.project_id}"
            f"/locations/global/collections/default_collection/engines/{self.as_app}"
            f"/assistants/default_assistant/agents"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-goog-user-project": self.project_id,
        }
        agents: list[Agent] = []
        page_token = None
        while True:
            data = _http_get(url, headers, {"pageToken": page_token} if page_token else {})
            for a in data.get("agents", []):
                # Admin view: list every agent regardless of state; the UI shows
                # a state badge (ENABLED/PRIVATE/...) so nothing is hidden.
                native_id = a.get("name", "")
                agents.append(Agent(
                    id=f"gemini:{native_id}",  # native_id already globally unique; keep stable prefix
                    provider="gemini",         # fixed internal key: the frontend keys icons on it
                    provider_label=self.label,
                    display_name=a.get("displayName") or "Unnamed Agent",
                    description=a.get("description") or "",
                    type=_gemini_type(a),
                    state=a.get("state", "UNKNOWN"),
                    icon=_icon_uri(a.get("icon")),
                    created_at=a.get("createTime"),
                    open_url=self._open_url(native_id),
                    raw=a,
                ))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        return agents


class VertexAgentEngineProvider:
    """Vertex AI Agent Engine (Reasoning Engine) deployments in one region."""

    def __init__(self, project_id: str, region: str, name: str, label: str):
        self.project_id = project_id
        self.region = region
        self.name = name    # unique per-connection health id, e.g. "vertex:<conn_id>"
        self.label = label  # connection label, or "Vertex Agent Engine" default

    def _open_url(self, engine_id: str) -> str:
        # ponytail: best-effort console deep link; revisit the path if it 404s.
        return (
            f"https://console.cloud.google.com/vertex-ai/agents/agent-engines/"
            f"locations/{self.region}/engines/{engine_id}?project={self.project_id}"
        )

    def list_agents(self) -> list[Agent]:
        token = _adc_token()
        url = (
            f"https://{self.region}-aiplatform.googleapis.com/v1/projects/{self.project_id}"
            f"/locations/{self.region}/reasoningEngines"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-goog-user-project": self.project_id,
        }
        agents: list[Agent] = []
        page_token = None
        while True:
            data = _http_get(url, headers, {"pageToken": page_token} if page_token else {})
            for a in data.get("reasoningEngines", []):
                native_id = a.get("name", "")
                engine_id = native_id.split("/")[-1]
                agents.append(Agent(
                    id=f"vertex:{native_id}",  # native_id already globally unique; keep stable prefix
                    provider="vertex",         # fixed internal key: the frontend keys icons on it
                    provider_label=self.label,
                    display_name=a.get("displayName") or "Unnamed Agent",
                    description=(a.get("spec") or {}).get("agentFramework") or "",
                    type="Reasoning Engine",
                    state="DEPLOYED",  # Reasoning Engines expose no lifecycle state field
                    icon=None,
                    created_at=a.get("createTime"),
                    open_url=self._open_url(engine_id),
                    raw=a,
                ))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        return agents


# --- License monitoring (Gemini Enterprise / Discovery Engine) ---------------
# Licenses are project+location scoped (not per-app), so this is a plain function
# keyed on project_id, not a provider. Callers dedupe by project_id.

def _license_status(assigned: int, allocated: int, state: str) -> str:
    if state in ("EXPIRED", "WITHDRAWN"):
        return "EXPIRED"
    if allocated == 0 or assigned == 0:
        return "UNASSIGNED"
    util = assigned / allocated * 100
    if util >= 80:
        return "HEALTHY"
    if util >= 40:
        return "WARNING"
    return "CRITICAL"


def _license_date(d: dict | None) -> str | None:
    if not d:
        return None
    return f"{d.get('year', 0):04d}-{d.get('month', 0):02d}-{d.get('day', 0):02d}"


def list_license_configs(project_id: str, location: str = "global") -> list[dict]:
    """Gemini Enterprise license allocation + usage for one project.

    Merges licenseConfigs (allocated seats) with licenseConfigsUsageStats
    (assigned seats). Raises on a hard API/permission error so the caller can
    surface it as per-project health; usage stats are best-effort (a stats-only
    permission gap just leaves assigned=0).
    """
    headers = {
        "Authorization": f"Bearer {_adc_token()}",
        "Content-Type": "application/json",
        "x-goog-user-project": project_id,
    }
    base = f"https://discoveryengine.googleapis.com/v1/projects/{project_id}/locations/{location}"
    configs = _http_get(f"{base}/licenseConfigs", headers, {}).get("licenseConfigs", [])
    if not configs:
        return []
    usage: dict[str, int] = {}
    try:
        stats = _http_get(
            f"{base}/userStores/default_user_store/licenseConfigsUsageStats", headers, {}
        ).get("licenseConfigUsageStats", [])
        usage = {s.get("licenseConfig"): int(s.get("usedLicenseCount", 0)) for s in stats}
    except Exception:
        pass  # stats optional: keep allocated seats visible with assigned=0
    out = []
    for cfg in configs:
        full = cfg.get("name", "")
        allocated = int(cfg.get("licenseCount", 0))
        assigned = usage.get(full, 0)
        state = cfg.get("state", "ACTIVE")
        out.append({
            "project_id": project_id,
            "license_config_id": full.split("/")[-1] if full else "",
            "subscription_tier": cfg.get("subscriptionTier", ""),
            "state": state,
            "allocated_seats": allocated,
            "assigned_count": assigned,
            "available_count": max(0, allocated - assigned),
            "utilization_rate": round(assigned / allocated * 100, 2) if allocated else 0.0,
            "status": _license_status(assigned, allocated, state),
            "start_date": _license_date(cfg.get("startDate")),
            "end_date": _license_date(cfg.get("endDate")),
        })
    return out


# --- Antigravity usage telemetry (BigQuery inference_response sink) -----------
# Usage is telemetry, not agents, so this is a plain function, not a provider. It
# reads the central BigQuery sink table populated by an org/folder log sink, scoped
# to the caller's project_ids. Aggregation mirrors the ge-monitoring reference.

_AGY_QUERY = """
WITH deduped AS (
    SELECT
        timestamp,
        COALESCE(REGEXP_EXTRACT(logName, r'projects/([^/]+)/logs'), resource.labels.resource_container, '') AS project_id,
        COALESCE(labels.user_id, '') AS user_id,
        COALESCE(labels.model, '') AS model,
        COALESCE(SAFE_CAST(jsonpayload_v1_inferenceresponselog.metadata.totaltokencount AS INT64), 0) AS total_token_count
    FROM `{table_ref}`
    WHERE timestamp >= @since
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY COALESCE(labels.request_id, insertId) ORDER BY timestamp DESC
    ) = 1
)
SELECT timestamp, project_id, user_id, model, total_token_count
FROM deduped
WHERE project_id IN UNNEST(@project_ids)
ORDER BY timestamp DESC
"""


def _agy_bq_config() -> tuple[str, str, str | None]:
    return (
        os.getenv("CENTRAL_PROJECT") or os.getenv("ANTIGRAVITY_BQ_PROJECT") or "",
        os.getenv("ANTIGRAVITY_BQ_DATASET") or "antigravity_monitoring",
        os.getenv("ANTIGRAVITY_BQ_LOCATION") or None,
    )


def _empty_usage() -> dict:
    return {
        "summary": {"total_inferences": 0, "total_tokens": 0, "active_users": 0,
                    "monitored_projects": 0, "avg_tokens_per_request": 0.0},
        "projects": [], "daily": [], "top_users": [],
    }


def _run_bq(table_ref: str, since, project_ids: list[str], project: str, location: str | None) -> list[dict]:
    """Run the dedup query and return raw rows. Seam for tests to monkeypatch."""
    from google.cloud import bigquery
    client = bigquery.Client(project=project)
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("since", "TIMESTAMP", since),
        bigquery.ArrayQueryParameter("project_ids", "STRING", list(project_ids)),
    ])
    job = client.query(_AGY_QUERY.format(table_ref=table_ref), job_config=job_config, location=location)
    return [dict(row) for row in job.result()]


def _primary_model(models: dict) -> str:
    return max(models, key=models.get) if models else ""


def _aggregate_usage(rows: list[dict]) -> dict:
    # ponytail: aggregates all deduped rows in memory; push GROUP BY into SQL if an
    # org's row volume ever makes this the bottleneck.
    users: set = set()
    projects: dict = {}
    per_user: dict = {}
    daily: dict = {}
    total_tokens = 0
    for r in rows:
        tk = int(r.get("total_token_count") or 0)
        total_tokens += tk
        pid = str(r.get("project_id") or "")
        uid = str(r.get("user_id") or "")
        model = str(r.get("model") or "")
        ts = r.get("timestamp")
        ts_str = str(ts)
        day = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else ts_str[:10]
        if uid:
            users.add(uid)
        pr = projects.setdefault(pid, {"requests": 0, "tokens": 0, "users": set(), "models": {}})
        pr["requests"] += 1
        pr["tokens"] += tk
        if uid:
            pr["users"].add(uid)
        if model:
            pr["models"][model] = pr["models"].get(model, 0) + 1
        ud = per_user.setdefault((pid, uid), {"project_id": pid, "user_id": uid, "requests": 0,
                                              "tokens": 0, "models": {}, "last_active": ts_str})
        ud["requests"] += 1
        ud["tokens"] += tk
        if model:
            ud["models"][model] = ud["models"].get(model, 0) + 1
        if ts_str > ud["last_active"]:  # ISO strings sort lexically == chronologically
            ud["last_active"] = ts_str
        dd = daily.setdefault(day, {"requests": 0, "tokens": 0, "users": set(), "projects": {}})
        dd["requests"] += 1
        dd["tokens"] += tk
        if uid:
            dd["users"].add(uid)
        if pid:
            dp = dd["projects"].setdefault(pid, {"requests": 0, "tokens": 0, "users": set()})
            dp["requests"] += 1
            dp["tokens"] += tk
            if uid:
                dp["users"].add(uid)
    project_rows = sorted(
        ({"project_id": pid, "total_requests": p["requests"], "total_tokens": p["tokens"],
          "active_users": len(p["users"]), "primary_model": _primary_model(p["models"])}
         for pid, p in projects.items()),
        key=lambda x: x["total_tokens"], reverse=True)
    top_users = sorted(
        ({"user_id": u["user_id"], "project_id": u["project_id"], "total_requests": u["requests"],
          "total_tokens": u["tokens"], "primary_model": _primary_model(u["models"]),
          "last_active": u["last_active"]}
         for u in per_user.values() if u["user_id"]),
        key=lambda x: x["total_tokens"], reverse=True)
    daily_rows = [
        {"date": day, "requests": daily[day]["requests"], "tokens": daily[day]["tokens"],
         "active_users": len(daily[day]["users"]),
         "breakdown": {pid: {"requests": v["requests"], "tokens": v["tokens"], "users": len(v["users"])}
                       for pid, v in daily[day]["projects"].items()}}
        for day in sorted(daily)]
    total_inf = len(rows)
    return {
        "summary": {"total_inferences": total_inf, "total_tokens": total_tokens,
                    "active_users": len(users), "monitored_projects": len(projects),
                    "avg_tokens_per_request": round(total_tokens / max(total_inf, 1), 1)},
        "projects": project_rows, "daily": daily_rows, "top_users": top_users,
    }


def list_antigravity_usage(project_ids: list[str], days: int = 30) -> dict:
    """Antigravity inference telemetry for project_ids over the last `days`.

    Reads the central BigQuery inference_response sink table (env CENTRAL_PROJECT /
    ANTIGRAVITY_BQ_DATASET / ANTIGRAVITY_BQ_LOCATION), dedupes by request_id, and
    aggregates. Scope is the caller's project_ids (WHERE project_id IN ...). Returns
    zeroed aggregates when unconfigured or when the table has no rows; raises on a
    hard BigQuery error so the caller can surface it as health.
    """
    bq_project, dataset, location = _agy_bq_config()
    if not bq_project or not project_ids:
        return _empty_usage()
    since = datetime.now(timezone.utc) - timedelta(days=days)
    table_ref = f"{bq_project}.{dataset}.businessaicode_googleapis_com_inference_response"
    return _aggregate_usage(_run_bq(table_ref, since, project_ids, bq_project, location))


def registry() -> list[AgentProvider]:
    """Build the active provider list: one provider per stored connection."""
    conns = config_store.load()
    if not conns:  # back-compat: seed one connection from env, then persist
        project_id = os.getenv("PROJECT_ID")
        as_app = os.getenv("AS_APP")
        if project_id and as_app:
            conns = [{
                "id": secrets.token_hex(4),
                "provider": "gemini",
                "project_id": project_id,
                "app_id": as_app,
                "cid": os.getenv("CID") or "",
                "label": "",
            }]
            config_store.save(conns)
    provs: list[AgentProvider] = []
    for c in conns:
        provider = c.get("provider") or "gemini"  # back-compat: pre-discriminator rows are Gemini
        if provider == "vertex":
            provs.append(VertexAgentEngineProvider(
                c["project_id"], c.get("region") or "us-central1",
                name="vertex:" + c["id"],
                label=c.get("label") or "Vertex Agent Engine",
            ))
        else:
            provs.append(GeminiProvider(
                c["project_id"], c["app_id"], c.get("cid") or "",
                name="gemini:" + c["id"],
                label=c.get("label") or "Gemini Enterprise",
            ))
    return provs
