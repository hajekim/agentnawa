"""Unit tests for the provider adapters: type mapping, HTTP retry, list parsing,
and the connection->provider registry. All network is monkeypatched out."""
from datetime import datetime, timedelta, timezone

import pytest

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


# --- license monitoring -----------------------------------------------------

def test_license_status():
    assert providers._license_status(90, 100, "ACTIVE") == "HEALTHY"
    assert providers._license_status(50, 100, "ACTIVE") == "WARNING"
    assert providers._license_status(10, 100, "ACTIVE") == "CRITICAL"
    assert providers._license_status(0, 100, "ACTIVE") == "UNASSIGNED"
    assert providers._license_status(90, 100, "EXPIRED") == "EXPIRED"


def test_list_license_configs_merges_usage(monkeypatch):
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    configs = {"licenseConfigs": [{
        "name": "projects/p/locations/global/licenseConfigs/ge",
        "licenseCount": 100, "state": "ACTIVE",
        "subscriptionTier": "SUBSCRIPTION_TIER_ENTERPRISE",
        "startDate": {"year": 2024, "month": 1, "day": 5}}]}
    stats = {"licenseConfigUsageStats": [
        {"licenseConfig": "projects/p/locations/global/licenseConfigs/ge", "usedLicenseCount": 80}]}

    def fake_http_get(url, headers, params):
        return stats if "licenseConfigsUsageStats" in url else configs

    monkeypatch.setattr(providers, "_http_get", fake_http_get)
    rows = providers.list_license_configs("p")
    assert len(rows) == 1
    r = rows[0]
    assert r["project_id"] == "p" and r["license_config_id"] == "ge"
    assert r["allocated_seats"] == 100 and r["assigned_count"] == 80
    assert r["available_count"] == 20 and r["utilization_rate"] == 80.0
    assert r["status"] == "HEALTHY" and r["start_date"] == "2024-01-05"


def test_list_license_configs_empty(monkeypatch):
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    monkeypatch.setattr(providers, "_http_get", lambda url, headers, params: {})
    assert providers.list_license_configs("p") == []


def test_list_license_configs_stats_optional(monkeypatch):
    # usageStats failing must NOT blank the config: assigned defaults to 0
    monkeypatch.setattr(providers, "_adc_token", lambda: "t")
    configs = {"licenseConfigs": [{
        "name": "projects/p/locations/global/licenseConfigs/ge", "licenseCount": 50}]}

    def fake_http_get(url, headers, params):
        if "licenseConfigsUsageStats" in url:
            raise RuntimeError("stats 403")
        return configs

    monkeypatch.setattr(providers, "_http_get", fake_http_get)
    rows = providers.list_license_configs("p")
    assert rows[0]["allocated_seats"] == 50 and rows[0]["assigned_count"] == 0
    assert rows[0]["status"] == "UNASSIGNED"


# --- Antigravity usage aggregation ------------------------------------------
# Rows fed to _aggregate_usage are already deduped by the SQL (QUALIFY); these
# tests cover the in-memory aggregation, not the dedup.

def _agy_row(pid, uid, model, tokens, ts):
    return {"project_id": pid, "user_id": uid, "model": model,
            "total_token_count": tokens, "timestamp": ts}


def test_aggregate_usage_totals_projects_daily_users():
    rows = [
        _agy_row("p1", "user:a", "gemini", 100, datetime(2026, 8, 1, 10, tzinfo=timezone.utc)),
        _agy_row("p1", "user:a", "gemini", 50, datetime(2026, 8, 1, 12, tzinfo=timezone.utc)),
        _agy_row("p1", "user:b", "flash", 10, datetime(2026, 8, 2, 9, tzinfo=timezone.utc)),
        _agy_row("p2", "user:a", "gemini", 200, datetime(2026, 8, 2, 9, tzinfo=timezone.utc)),
    ]
    agg = providers._aggregate_usage(rows)

    s = agg["summary"]
    assert s["total_inferences"] == 4
    assert s["total_tokens"] == 360
    assert s["active_users"] == 2          # user:a + user:b, distinct across projects
    assert s["monitored_projects"] == 2
    assert s["avg_tokens_per_request"] == 90.0

    # projects sorted by tokens desc: p2 (200) before p1 (160)
    assert [p["project_id"] for p in agg["projects"]] == ["p2", "p1"]
    p1 = next(p for p in agg["projects"] if p["project_id"] == "p1")
    assert p1["total_requests"] == 3 and p1["total_tokens"] == 160
    assert p1["active_users"] == 2 and p1["primary_model"] == "gemini"  # 2 gemini > 1 flash

    daily = {d["date"]: d for d in agg["daily"]}
    assert [d["date"] for d in agg["daily"]] == ["2026-08-01", "2026-08-02"]  # ascending
    assert daily["2026-08-01"]["requests"] == 2 and daily["2026-08-01"]["tokens"] == 150
    assert daily["2026-08-01"]["active_users"] == 1  # user:a twice in one day -> distinct 1
    assert daily["2026-08-01"]["breakdown"]["p1"]["requests"] == 2
    assert daily["2026-08-02"]["active_users"] == 2
    assert daily["2026-08-02"]["breakdown"]["p2"]["tokens"] == 200

    # top_users are per (project, user); user:a appears once per project, tokens desc
    assert [(u["user_id"], u["project_id"], u["total_tokens"]) for u in agg["top_users"]] == [
        ("user:a", "p2", 200), ("user:a", "p1", 150), ("user:b", "p1", 10)]
    assert agg["top_users"][0]["last_active"].startswith("2026-08-02")
    # multi-row user keeps the MOST-RECENT timestamp (p1/user:a: 10:00 and 12:00)
    assert agg["top_users"][1]["last_active"].startswith("2026-08-01 12")


def test_aggregate_usage_excludes_empty_user():
    rows = [_agy_row("p1", "", "m", 5, datetime(2026, 8, 1, tzinfo=timezone.utc))]
    agg = providers._aggregate_usage(rows)
    assert agg["top_users"] == []                       # anonymous rows never surface as a user
    assert agg["summary"]["active_users"] == 0          # empty uid not counted
    assert agg["projects"][0]["total_requests"] == 1    # but the request still counts


def test_aggregate_usage_empty_equals_empty_usage():
    assert providers._aggregate_usage([]) == providers._empty_usage()


# --- Antigravity usage entrypoint -------------------------------------------

def test_list_antigravity_usage_unconfigured(monkeypatch):
    monkeypatch.delenv("CENTRAL_PROJECT", raising=False)
    monkeypatch.delenv("ANTIGRAVITY_BQ_PROJECT", raising=False)
    # no central project -> zeros without touching BigQuery
    assert providers.list_antigravity_usage(["p1"]) == providers._empty_usage()


def test_list_antigravity_usage_no_projects(monkeypatch):
    monkeypatch.setenv("CENTRAL_PROJECT", "central")
    assert providers.list_antigravity_usage([]) == providers._empty_usage()


def test_list_antigravity_usage_table_not_created_yet(monkeypatch):
    # forward-only sink: the table exists only after the first log lands, so a missing
    # table is a benign "waiting for first log" state -> zeros, not an error.
    monkeypatch.setenv("CENTRAL_PROJECT", "central")
    monkeypatch.delenv("ANTIGRAVITY_BQ_DATASET", raising=False)

    def fake_run(*a, **k):
        raise RuntimeError("404 Not found: Table central.antigravity_monitoring."
                           "businessaicode_googleapis_com_inference_response was not found")

    monkeypatch.setattr(providers, "_run_bq", fake_run)
    assert providers.list_antigravity_usage(["p1"]) == providers._empty_usage()


def test_list_antigravity_usage_other_bq_error_raises(monkeypatch):
    # a missing dataset / other BigQuery error is a real misconfig -> still raises
    monkeypatch.setenv("CENTRAL_PROJECT", "central")

    def fake_run(*a, **k):
        raise RuntimeError("Not found: Dataset central:antigravity_monitoring")

    monkeypatch.setattr(providers, "_run_bq", fake_run)
    with pytest.raises(RuntimeError):
        providers.list_antigravity_usage(["p1"])


def test_list_antigravity_usage_runs_query(monkeypatch):
    monkeypatch.setenv("CENTRAL_PROJECT", "central")
    monkeypatch.delenv("ANTIGRAVITY_BQ_DATASET", raising=False)
    seen = {}

    def fake_run(table_ref, since, project_ids, project, location):
        seen.update(table_ref=table_ref, since=since, project_ids=list(project_ids), project=project)
        return [_agy_row("p1", "user:a", "m", 42, datetime(2026, 8, 1, tzinfo=timezone.utc))]

    monkeypatch.setattr(providers, "_run_bq", fake_run)
    out = providers.list_antigravity_usage(["p1", "p2"], days=7)
    assert out["summary"]["total_inferences"] == 1 and out["summary"]["total_tokens"] == 42
    assert seen["project_ids"] == ["p1", "p2"] and seen["project"] == "central"
    # default dataset baked into the fully-qualified table ref
    assert seen["table_ref"] == "central.antigravity_monitoring.businessaicode_googleapis_com_inference_response"
    # days -> query window: `since` is ~7 days before now (catches a days/hours unit slip)
    window = datetime.now(timezone.utc) - seen["since"]
    assert abs(window - timedelta(days=7)) < timedelta(seconds=5)
