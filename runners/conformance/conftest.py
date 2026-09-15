import pytest
from fastapi.testclient import TestClient
from sardeenz_vllm_runner.testing import build_conformance_app as _vllm
from sardeenz_mlserver_runner.testing import build_conformance_app as _mlserver

_BUILDERS = {"vllm": _vllm, "mlserver": _mlserver}


@pytest.fixture(params=list(_BUILDERS), ids=list(_BUILDERS))
def shim_client(request):
    app = _BUILDERS[request.param]()
    with TestClient(app) as client:  # runs lifespan → poller flips READY via _FakeEngine
        _wait_ready(client)
        yield request.param, client


def _wait_ready(client, attempts: int = 100):
    for _ in range(attempts):
        r = client.get("/health")
        if r.status_code == 200 and r.json().get("state") == "READY":
            return
    raise AssertionError(f"shim never reached READY: last={client.get('/health').json()}")
