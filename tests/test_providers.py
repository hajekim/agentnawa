"""Unit tests for the provider adapters: type mapping, HTTP retry, list parsing,
and the connection->provider registry. All network is monkeypatched out."""
import providers


# --- pure helpers -----------------------------------------------------------

def test_gemini_type_mapped():
    assert providers._gemini_type({"adkAgentDefinition": {}}) == "High Code"
    assert providers._gemini_type({"a2aAgentDefinition": {}}) == "A2A"
    assert providers._gemini_type({"managedAgentDefinition": {}}) == "Managed"


def test_gemini_type_undocumented():
    # unknown *AgentDefinition key -> label derived by stripping the suffix
    assert providers._gemini_type({"customAgentDefinition": {}}) == "custom"


def test_gemini_type_unknown():
    assert providers._gemini_type({}) == "Unknown"


def test_icon_uri():
    assert providers._icon_uri({"uri": "x"}) == "x"
    assert providers._icon_uri("y") == "y"
    assert providers._icon_uri(None) is None


# --- HTTP retry -------------------------------------------------------------

class _FakeResp:
    def __init__(self, status, json_data=None, headers=None):
        self.status_code = status
        self._json = json_data or {}
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("raise_for_status should not fire in this test")

    def json(self):
        return self._json


def test_http_get_retries(monkeypatch):
    responses = [_FakeResp(503, headers={"Retry-After": "0"}), _FakeResp(200, {"ok": 1})]
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(1)
        return responses[len(calls) - 1]

    monkeypatch.setattr(providers.requests, "get", fake_get)
    monkeypatch.setattr(providers.time, "sleep", lambda s: None)
    assert providers._http_get("http://x", {}, {}) == {"ok": 1}
    assert len(calls) == 2  # one 503 retry, then success


# --- GeminiProvider ---------------------------------------------------------

def test_gemini_list_agents(monkeypatch):
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    pages = [
        {"agents": [{"name": "projects/p/agents/a1", "displayName": "A1",
                     "adkAgentDefinition": {}, "state": "ENABLED", "createTime": "2024-01-01"}],
         "nextPageToken": "tok"},
        {"agents": [{"name": "projects/p/agents/a2", "displayName": "A2",
                     "a2aAgentDefinition": {}}]},
    ]
    seen = []

    def fake_http_get(url, headers, params):
        seen.append(params)
        return pages[len(seen) - 1]

    monkeypatch.setattr(providers, "_http_get", fake_http_get)
    agents = providers.GeminiProvider("p", "app", "cid123", name="gemini:x", label="Gem").list_agents()

    assert [a.id for a in agents] == ["gemini:projects/p/agents/a1", "gemini:projects/p/agents/a2"]
    assert agents[0].provider == "gemini"
    assert agents[0].type == "High Code"
    assert agents[0].state == "ENABLED"
    assert agents[0].open_url.endswith("/agent/a1/session/-")
    assert agents[1].type == "A2A"
    assert agents[1].state == "UNKNOWN"          # missing state defaults
    assert seen == [{}, {"pageToken": "tok"}]     # second page carried the token


def test_gemini_open_url_none_without_cid(monkeypatch):
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    monkeypatch.setattr(providers, "_http_get",
                        lambda url, headers, params: {"agents": [{"name": "projects/p/agents/a1"}]})
    agents = providers.GeminiProvider("p", "app", "", name="gemini:x", label="Gem").list_agents()
    assert agents[0].open_url is None


# --- VertexAgentEngineProvider ---------------------------------------------

def test_vertex_list_agents(monkeypatch):
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    data = {"reasoningEngines": [{
        "name": "projects/p/locations/us-central1/reasoningEngines/7100",
        "displayName": "track5",
        "spec": {"agentFramework": "google-adk"},
        "createTime": "2024-05-05"}]}
    monkeypatch.setattr(providers, "_http_get", lambda url, headers, params: data)
    agents = providers.VertexAgentEngineProvider("p", "us-central1", name="vertex:x", label="Vx").list_agents()

    assert len(agents) == 1
    a = agents[0]
    assert a.id == "vertex:projects/p/locations/us-central1/reasoningEngines/7100"
    assert a.provider == "vertex"
    assert a.type == "Reasoning Engine"
    assert a.state == "DEPLOYED"
    assert a.description == "google-adk"
    assert a.icon is None
    assert "engines/7100" in a.open_url and "us-central1" in a.open_url


# --- registry() -------------------------------------------------------------

def test_registry_backcompat_gemini(monkeypatch):
    monkeypatch.setattr(providers.config_store, "load",
                        lambda: [{"id": "c1", "project_id": "p", "app_id": "app"}])
    provs = providers.registry()
    assert len(provs) == 1
    assert isinstance(provs[0], providers.GeminiProvider)
    assert provs[0].name == "gemini:c1"
    assert provs[0].label == "Gemini Enterprise"


def test_registry_vertex_branch(monkeypatch):
    monkeypatch.setattr(providers.config_store, "load",
                        lambda: [{"id": "v1", "provider": "vertex", "project_id": "p", "region": "europe-west4"}])
    provs = providers.registry()
    assert isinstance(provs[0], providers.VertexAgentEngineProvider)
    assert provs[0].region == "europe-west4"
    assert provs[0].name == "vertex:v1"


def test_registry_env_seed(monkeypatch):
    monkeypatch.setattr(providers.config_store, "load", lambda: [])
    saved = []
    monkeypatch.setattr(providers.config_store, "save", lambda conns: saved.append(conns))
    monkeypatch.setenv("PROJECT_ID", "proj")
    monkeypatch.setenv("AS_APP", "app")
    monkeypatch.setenv("CID", "cid9")

    provs = providers.registry()
    assert len(provs) == 1 and isinstance(provs[0], providers.GeminiProvider)
    assert saved and saved[0][0]["project_id"] == "proj"
    assert saved[0][0]["provider"] == "gemini"
