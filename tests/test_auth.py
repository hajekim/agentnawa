"""Auth tests: the login gate (open when OAUTH_CLIENT_ID unset, gating HTML vs
API otherwise) and the /auth/callback CSRF + domain-allowlist checks. The Google
token verification is stubbed via main._verify_token."""
import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def enabled(monkeypatch):
    """Login enabled: a client id + a domain allowlist."""
    monkeypatch.setattr(main, "OAUTH_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(main, "ALLOWED_DOMAINS", {"example.com", "corp.example.com"})
    # don't follow redirects, so we can assert on 302/303 themselves
    return TestClient(main.app, follow_redirects=False)


def _callback(client, monkeypatch, email, verified=True):
    monkeypatch.setattr(main, "_verify_token",
                        lambda tok: {"email": email, "email_verified": verified})
    return client.post("/auth/callback",
                       data={"credential": "tok", "g_csrf_token": "x"},
                       cookies={"g_csrf_token": "x"})


# --- the gate ---------------------------------------------------------------

def test_gate_off_when_unset(monkeypatch):
    monkeypatch.setattr(main, "OAUTH_CLIENT_ID", "")
    monkeypatch.setattr(main.providers, "registry", lambda: [])
    c = TestClient(main.app, follow_redirects=False)
    assert c.get("/").status_code == 200            # open: no login required
    assert c.get("/api/agents").status_code == 200


def test_gate_redirects_html(enabled):
    r = enabled.get("/")
    assert r.status_code == 302 and r.headers["location"] == "/login"


def test_gate_401_api(enabled):
    assert enabled.get("/api/agents").status_code == 401


def test_gate_allows_static(enabled):
    assert enabled.get("/static/index.html").status_code == 200  # assets never gated


# --- /auth/callback ---------------------------------------------------------

def test_callback_csrf_mismatch(enabled, monkeypatch):
    monkeypatch.setattr(main, "_verify_token", lambda tok: {"email": "a@google.com", "email_verified": True})
    r = enabled.post("/auth/callback",
                     data={"credential": "tok", "g_csrf_token": "x"},
                     cookies={"g_csrf_token": "different"})
    assert r.status_code == 400


def test_callback_allowed_domain_sets_session(enabled, monkeypatch):
    r = _callback(enabled, monkeypatch, "dev@example.com")
    assert r.status_code == 303 and r.headers["location"] == "/"
    # session now set -> the gate lets the home page through
    assert enabled.get("/").status_code == 200


def test_callback_rejects_other_domain(enabled, monkeypatch):
    r = _callback(enabled, monkeypatch, "someone@evil.com")
    assert r.status_code == 403


def test_callback_rejects_unverified_email(enabled, monkeypatch):
    r = _callback(enabled, monkeypatch, "dev@example.com", verified=False)
    assert r.status_code == 403


def test_callback_rejects_bad_token(enabled, monkeypatch):
    def boom(tok):
        raise ValueError("bad signature")
    monkeypatch.setattr(main, "_verify_token", boom)
    r = enabled.post("/auth/callback",
                     data={"credential": "tok", "g_csrf_token": "x"},
                     cookies={"g_csrf_token": "x"})
    assert r.status_code == 401
