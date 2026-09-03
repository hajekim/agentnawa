"""VPC-SC 403 detection: the _http_get parser must recognize a real perimeter
denial and extract its fields, while leaving a plain IAM 403 to raise_for_status.

VPC_SC_403 is a representative perimeter-denial body; IAM_403 is synthetic —
it only proves the parser does NOT over-match a same-status PERMISSION_DENIED."""
import json

import pytest
import requests

import providers

# A VPC-SC 403 (discoveryengine, cross-org ingress denial), fields anonymized.
VPC_SC_403 = {
    "error": {
        "code": 403,
        "message": ("Request is prohibited by organization's policy. "
                    "vpcServiceControlsUniqueIdentifier: UID123"),
        "status": "PERMISSION_DENIED",
        "details": [
            {"@type": "type.googleapis.com/google.rpc.PreconditionFailure",
             "violations": [{"type": "VPC_SERVICE_CONTROLS", "description": "UID123"}]},
            {"@type": "type.googleapis.com/google.rpc.ErrorInfo",
             "reason": "SECURITY_POLICY_VIOLATED",
             "domain": "googleapis.com",
             "metadata": {"service": "discoveryengine.googleapis.com",
                          "uid": "UID123", "troubleshootToken": "TOKEN456"}},
        ],
    }
}

# Synthetic plain IAM 403: same 403/PERMISSION_DENIED, but no VPC-SC signals.
IAM_403 = {
    "error": {
        "code": 403,
        "message": "Permission 'discoveryengine.assistants.list' denied on resource.",
        "status": "PERMISSION_DENIED",
        "details": [
            {"@type": "type.googleapis.com/google.rpc.ErrorInfo",
             "reason": "IAM_PERMISSION_DENIED",
             "domain": "discoveryengine.googleapis.com",
             "metadata": {"permission": "discoveryengine.assistants.list"}},
        ],
    }
}


def _resp(body, status=403, text=None):
    r = requests.Response()
    r.status_code = status
    r._content = (text if text is not None else json.dumps(body)).encode()
    return r


def test_vpc_sc_body_detected():
    denied = providers._vpc_sc_denied(_resp(VPC_SC_403))
    assert isinstance(denied, providers.VpcScDenied)
    assert denied.service == "discoveryengine.googleapis.com"
    assert denied.unique_id == "UID123"
    assert denied.troubleshoot_token == "TOKEN456"


def test_plain_iam_403_not_matched():
    assert providers._vpc_sc_denied(_resp(IAM_403)) is None


def test_non_json_body_not_matched():
    # an LB/proxy HTML 403 must fall through, not raise a JSONDecodeError
    assert providers._vpc_sc_denied(_resp(None, text="<html>403</html>")) is None


def test_http_get_raises_vpc_sc_before_raise_for_status(monkeypatch):
    monkeypatch.setattr(providers.requests, "get", lambda *a, **k: _resp(VPC_SC_403))
    with pytest.raises(providers.VpcScDenied):
        providers._http_get("https://x", {}, {})


def test_http_get_plain_403_still_raises_httperror(monkeypatch):
    monkeypatch.setattr(providers.requests, "get", lambda *a, **k: _resp(IAM_403))
    with pytest.raises(requests.HTTPError) as ei:
        providers._http_get("https://x", {}, {})
    # non-VPC-SC 403 now surfaces Google's own actionable message, not the generic one
    assert "denied on resource" in str(ei.value)
