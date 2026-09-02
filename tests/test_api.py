"""API tests via FastAPI TestClient: /api/agents fan-out (partial-failure
isolation, sorting), connection CRUD/validation, and the test-connection probe.
CRUD runs against a temp CONFIG_PATH; the fan-out tests stub the registry."""
import google.auth.exceptions
import pytest
from fastapi.testclient import TestClient

import main
import providers


def _agent(**kw):
    base = dict(id="gemini:1", provider="gemini", provider_label="G", display_name="n",
                description="", type="High Code", state="ENABLED", icon=None,
                created_at="2024-01-01", open_url=None, raw={})
    base.update(kw)
    return providers.Agent(**base)


class _FakeProv:
    def __init__(self, name, label, agents=None, exc=None):
        self.name, self.label = name, label
        self._agents, self._exc = agents or [], exc

    def list_agents(self):
        if self._exc:
            raise self._exc
        return self._agents


# --- /api/agents fan-out ----------------------------------------------------

def test_agents_partial_failure(monkeypatch):
    good = _FakeProv("gemini:g", "G", agents=[_agent(id="gemini:1")])
    bad = _FakeProv("vertex:b", "V", exc=RuntimeError("boom"))
    monkeypatch.setattr(main.providers, "registry", lambda: [good, bad])

    r = TestClient(main.app).get("/api/agents")
    assert r.status_code == 200  # one provider failing must NOT 500
    body = r.json()
    assert [a["id"] for a in body["agents"]] == ["gemini:1"]
    health = {h["name"]: h for h in body["providers"]}
    assert health["gemini:g"]["status"] == "ok" and health["gemini:g"]["count"] == 1
    assert health["vertex:b"]["status"] == "error" and "boom" in health["vertex:b"]["error"]


def test_agents_sorted(monkeypatch):
    p = _FakeProv("gemini:g", "G", agents=[
        _agent(id="gemini:old", created_at="2023-01-01"),
        _agent(id="gemini:new", created_at="2025-01-01")])
    monkeypatch.setattr(main.providers, "registry", lambda: [p])
    ids = [a["id"] for a in TestClient(main.app).get("/api/agents").json()["agents"]]
    assert ids == ["gemini:new", "gemini:old"]  # newest createTime first


# --- connection CRUD --------------------------------------------------------

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_PATH", str(tmp_path / "c.json"))
    monkeypatch.delenv("CONFIG_BUCKET", raising=False)
    return TestClient(main.app)


def test_create_vertex_201(client):
    r = client.post("/api/connections",
                    json={"provider": "vertex", "project_id": "p", "region": "us-central1", "label": "V"})
    assert r.status_code == 201
    body = r.json()
    assert body["provider"] == "vertex" and body["region"] == "us-central1" and "id" in body


def test_create_vertex_missing_region_400(client):
    r = client.post("/api/connections", json={"provider": "vertex", "project_id": "p"})
    assert r.status_code == 400


def test_create_gemini_missing_app_400(client):
    r = client.post("/api/connections", json={"project_id": "p"})  # provider defaults to gemini
    assert r.status_code == 400


def test_put_replace(client):
    cid = client.post("/api/connections",
                      json={"provider": "vertex", "project_id": "p", "region": "us-central1"}).json()["id"]
    r = client.put(f"/api/connections/{cid}",
                   json={"provider": "vertex", "project_id": "p", "region": "europe-west4", "label": "edited"})
    assert r.status_code == 200
    assert r.json()["region"] == "europe-west4" and r.json()["label"] == "edited"
    assert client.get("/api/connections").json()["connections"][0]["region"] == "europe-west4"


def test_put_404(client):
    r = client.put("/api/connections/nope", json={"project_id": "p", "app_id": "a"})
    assert r.status_code == 404


def test_delete_and_404(client):
    cid = client.post("/api/connections", json={"project_id": "p", "app_id": "a"}).json()["id"]
    assert client.delete(f"/api/connections/{cid}").status_code == 200
    assert client.delete(f"/api/connections/{cid}").status_code == 404


# --- /api/connections/test --------------------------------------------------

def test_connection_test_failure(client, monkeypatch):
    class BadProv:
        def __init__(self, *a, **k): pass
        def list_agents(self): raise RuntimeError("nope")

    monkeypatch.setattr(main.providers, "GeminiProvider", BadProv)
    r = client.post("/api/connections/test", json={"project_id": "p", "app_id": "a"})
    assert r.status_code == 200  # probe never 500s
    assert r.json()["ok"] is False and r.json()["hint"] == ""


def test_connection_test_creds_hint(client, monkeypatch):
    class CredProv:
        def __init__(self, *a, **k): pass
        def list_agents(self): raise google.auth.exceptions.DefaultCredentialsError("no creds")

    monkeypatch.setattr(main.providers, "GeminiProvider", CredProv)
    r = client.post("/api/connections/test", json={"project_id": "p", "app_id": "a"})
    assert r.json()["ok"] is False
    assert "application-default login" in r.json()["hint"]
