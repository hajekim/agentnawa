"""Agent providers: one thin adapter per platform.

Each provider owns its own base URL, auth, pagination, response parsing, and
open_url computation, and emits the normalized `Agent` shape the UI renders.
Add a platform by writing a new provider class and registering it in registry().
"""
import dataclasses
import os
import secrets
import time
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


def _http_get(url: str, headers: dict, params: dict) -> dict:
    for attempt in range(3):
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        if resp.status_code in (429, 503) and attempt < 2:
            time.sleep(float(resp.headers.get("Retry-After", 1)))
            continue
        resp.raise_for_status()
        return resp.json()
    return {}


class GeminiProvider:
    """Google Gemini Enterprise (Discovery Engine) agents for one Agentspace app."""

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
