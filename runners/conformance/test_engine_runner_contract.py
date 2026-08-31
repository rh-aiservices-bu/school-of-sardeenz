"""Shared engine-runner contract-conformance suite (issue #125 Deliverable 5).

Parametrized over both shims via the `shim_client` fixture (conftest.py), which drives each
shim's real FastAPI `create_app()` — with a fake engine + canned memory report substituted through
the per-shim `sardeenz_<engine>_runner.testing.build_conformance_app()` adapter — under
`fastapi.testclient.TestClient`. Assertions are against the contract
(packages/contracts/specs/engine-runner.yaml), not engine internals: both shims must pass every
case here identically.
"""

from __future__ import annotations


def test_health_ready_shape(shim_client):
    _name, client = shim_client
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "READY"
    if "activeRequests" in body:
        assert body["activeRequests"] is None or isinstance(body["activeRequests"], int)
    assert "progress" not in body


def test_capabilities_shape(shim_client):
    name, client = shim_client
    resp = client.get("/capabilities")
    assert resp.status_code == 200
    body = resp.json()
    for key in (
        "runnerType",
        "engineName",
        "engineVersion",
        "supportedModelTypes",
        "supportedDeviceTypes",
        "supportedSleepLevels",
        "maxTensorParallelism",
        "kvCacheElasticSharing",
        "features",
    ):
        assert key in body, f"{name}: missing capabilities key {key!r}"
    assert body["runnerType"] == name
    assert isinstance(body["supportedModelTypes"], list) and body["supportedModelTypes"]
    assert body["supportedSleepLevels"] == ["L1_HOST_RAM"]
    assert body["maxTensorParallelism"] >= 1
    assert isinstance(body["kvCacheElasticSharing"], bool)
    assert isinstance(body["features"], dict)


def test_memory_report_shape(shim_client):
    _name, client = shim_client
    resp = client.get("/memory-report")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["devices"]) >= 1
    for device in body["devices"]:
        for key in ("deviceIndex", "deviceType", "memoryUsedBytes", "memoryTotalBytes"):
            assert key in device
        # Optional kvcached pool block (#165): absent unless the runner has a
        # kvcached pool on the device; when present, it must be a full partition.
        if "kvCache" in device:
            kv = device["kvCache"]
            for key in ("totalBytes", "usedBytes", "preallocBytes", "freeBytes"):
                assert key in kv, f"{_name}: kvCache missing {key!r}"
                assert isinstance(kv[key], int) and kv[key] >= 0
            assert kv["totalBytes"] == kv["usedBytes"] + kv["preallocBytes"] + kv["freeBytes"]


def test_progress_shape(shim_client):
    _name, client = shim_client
    resp = client.get("/progress")
    assert resp.status_code == 200
    body = resp.json()
    assert "phase" in body
    assert "percentComplete" in body


def test_sleep_status_initial(shim_client):
    _name, client = shim_client
    resp = client.get("/sleep-status")
    assert resp.status_code == 200
    assert resp.json() == {"isSleeping": False}


def test_sleep_bad_level_400(shim_client):
    _name, client = shim_client
    resp = client.post("/sleep", json={"level": "L2_DISK"})
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    assert "code" in body


def test_sleep_then_wake_transition(shim_client):
    """The sleep→wake state-machine case both shims must pass identically."""
    _name, client = shim_client

    sleep_resp = client.post("/sleep", json={"level": "L1_HOST_RAM"})
    assert sleep_resp.status_code == 200
    sleep_body = sleep_resp.json()
    assert sleep_body["state"] == "SLEEPING"
    assert sleep_body["level"] == "L1_HOST_RAM"
    assert isinstance(sleep_body["deviceMemoryFreedBytes"], int)

    status_resp = client.get("/sleep-status")
    assert status_resp.status_code == 200
    assert status_resp.json() == {"isSleeping": True, "level": "L1_HOST_RAM"}

    wake_resp = client.post("/wake")
    assert wake_resp.status_code == 200
    assert wake_resp.json()["state"] == "READY"

    status_resp2 = client.get("/sleep-status")
    assert status_resp2.status_code == 200
    assert status_resp2.json() == {"isSleeping": False}


def test_error_shape_on_bad_sleep_body(shim_client):
    _name, client = shim_client
    resp = client.post("/sleep")
    assert resp.status_code == 400
    body = resp.json()
    assert "error" in body
    assert "code" in body
