"""Agent providers: one thin adapter per platform.

Each provider owns its own base URL, auth, pagination, response parsing, and
open_url computation, and emits the normalized `Agent` shape the UI renders.
Add a platform by writing a new provider class and registering it in registry().
"""
import dataclasses
import os
import time
from typing import Protocol

import google.auth
import google.auth.transport.requests
import requests


@dataclasses.dataclass(frozen=True)
class Agent:
    id: str            # global, namespaced: f"{provider}:{native_id}"
    provider: str      # "gemini" | "m365" | "custom" | ...
    display_name: str
    description: str
    type: str          # normalized kind (open set): "High Code" | "Low/No Code" | "A2A" | ...
    state: str
    icon: str | None
    created_at: str | None
    open_url: str | None  # server-computed human deep link (null when a type has none)
    raw: dict          # untouched provider record; new fields land here without a schema change


class AgentProvider(Protocol):
    name: str

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


class GeminiProvider:
    """Google Gemini Enterprise (Discovery Engine) agents for one Agentspace app."""

    name = "gemini"

    def __init__(self, project_id: str, as_app: str, cid: str | None):
        self.project_id = project_id
        self.as_app = as_app
        self.cid = cid

    def _token(self) -> str:
        credentials, _ = google.auth.default()
        if not credentials.valid:
            credentials.refresh(google.auth.transport.requests.Request())
        return credentials.token

    def _open_url(self, native_id: str) -> str | None:
        if not self.cid:
            return None
        agent_id = native_id.split("/")[-1]
        # ponytail: Vertex assistant deep link verified for lowCode only; reused for
        # all types as the best available launch URL. Revisit per-type if any 404s.
        return f"https://vertexaisearch.cloud.google.com/home/cid/{self.cid}/r/agent/{agent_id}/session/-"

    def _get(self, url: str, headers: dict, params: dict) -> dict:
        for attempt in range(3):
            resp = requests.get(url, headers=headers, params=params, timeout=30)
            if resp.status_code in (429, 503) and attempt < 2:
                time.sleep(float(resp.headers.get("Retry-After", 1)))
                continue
            resp.raise_for_status()
            return resp.json()
        return {}

    def list_agents(self) -> list[Agent]:
        token = self._token()
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
            data = self._get(url, headers, {"pageToken": page_token} if page_token else {})
            for a in data.get("agents", []):
                if a.get("state") != "ENABLED":
                    continue
                native_id = a.get("name", "")
                agents.append(Agent(
                    id=f"{self.name}:{native_id}",
                    provider=self.name,
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


def registry() -> list[AgentProvider]:
    """Build the active provider list from environment. Add providers here."""
    provs: list[AgentProvider] = []
    project_id = os.getenv("PROJECT_ID")
    as_app = os.getenv("AS_APP")
    if project_id and as_app:
        provs.append(GeminiProvider(project_id, as_app, os.getenv("CID")))
    return provs
