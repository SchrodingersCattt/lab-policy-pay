from __future__ import annotations

import pytest
import requests
from labpolicy import app as lab
from labpolicy.integrations import IntegrationError, model_json


@pytest.fixture
def client(tmp_path):
    app = lab.create_app(tmp_path)
    app.config.update(TESTING=True, SECRET_KEY="test-secret")
    return app.test_client()


def confirm(client, budget="500", threshold="75", maximum="200"):
    response = client.post("/api/policy/confirm", json={"notice": "Budget notice", "budget": budget,
                           "approval_threshold": threshold, "max_single": maximum,
                           "evidence": {}, "confirmed": True})
    assert response.status_code == 201


def expense(client, amount="45", kind="purchase"):
    response = client.post("/api/expenses", json={"project": "Crystal Lab", "description": "Test expense", "amount": amount,
                           "kind": kind, "recipient": "sb-test@personal.example.com"})
    assert response.status_code == 201
    return response.get_json()


def test_model_values_without_exact_evidence_are_not_trusted(monkeypatch):
    monkeypatch.setattr(lab, "model_json", lambda *_: {"budget": "500", "approval_threshold": "75", "max_single": "200",
        "evidence": {"budget": "monthly budget $500", "approval_threshold": "invented text", "max_single": None}})
    result = lab.extract_policy("The monthly budget $500 is approved.")
    assert result["budget"] == "500.00"
    assert result["approval_threshold"] is None and result["max_single"] is None
    assert len(result["warnings"]) == 2


def test_human_confirmation_budget_reservations_and_policy_changes(client):
    assert client.post("/api/policy/confirm", json={"confirmed": False}).status_code == 400
    confirm(client)
    blocked = expense(client, "201")
    assert blocked["status"] == "blocked"
    first = expense(client, "200")
    assert client.post(f"/api/expenses/{first['id']}/approve", json={"confirmed": False}).status_code == 400
    assert client.post(f"/api/expenses/{first['id']}/approve", json={"confirmed": True}).get_json()["status"] == "approved"
    second = expense(client, "200")
    assert client.post(f"/api/expenses/{second['id']}/approve", json={"confirmed": True}).status_code == 200
    assert expense(client, "150")["status"] == "blocked"
    assert client.get("/api/dashboard").get_json()["committed"] == "400.00"
    assert client.post(f"/api/expenses/{second['id']}/cancel").status_code == 200
    assert client.get("/api/dashboard").get_json()["committed"] == "200.00"
    confirm(client, budget="500", maximum="100")
    response = client.post(f"/api/expenses/{first['id']}/pay")
    assert response.status_code == 409
    assert client.get("/api/dashboard").get_json()["committed"] == "0.00"


def test_reimbursement_waits_for_item_success(client, monkeypatch):
    confirm(client)
    request = expense(client, "40", "reimbursement")
    assert client.post(f"/api/expenses/{request['id']}/approve", json={"confirmed": True}).status_code == 200
    states = iter([{"batch_status": "SUCCESS", "item_status": "UNCLAIMED"},
                   {"batch_status": "SUCCESS", "item_status": "SUCCESS"}])

    class Gateway:
        def create_payout(self, reference, amount, receiver):
            return {"batch_id": "BATCH-1", "status": "PENDING"}

        def payout_status(self, batch, reference):
            return next(states)

    monkeypatch.setattr(lab, "PayPalSandbox", Gateway)
    assert client.post(f"/api/expenses/{request['id']}/pay").get_json()["status"] == "payout_pending"
    assert client.post(f"/api/expenses/{request['id']}/pay").status_code == 400
    assert client.post(f"/api/expenses/{request['id']}/refresh").get_json()["status"] == "unclaimed"
    assert client.post(f"/api/expenses/{request['id']}/refresh").get_json()["status"] == "paid"


def test_purchase_requires_matching_verified_capture(client, monkeypatch):
    confirm(client)
    row = expense(client)
    client.post(f"/api/expenses/{row['id']}/approve", json={"confirmed": True})

    class Gateway:
        def create_order(self, reference, amount, description):
            return {"id": "ORDER-1", "approval_url": "https://sandbox.example/approve"}

        def capture_order(self, order_id, reference, amount):
            assert order_id == "ORDER-1" and reference == row["id"] and amount == "45.00"
            return {"capture_id": "CAPTURE-1"}

    monkeypatch.setattr(lab, "PayPalSandbox", Gateway)
    assert client.post(f"/api/expenses/{row['id']}/pay").status_code == 200
    assert "payment=failed" in client.get("/checkout/return?token=OTHER").location
    assert client.get("/api/dashboard").get_json()["expenses"][0]["status"] == "checkout_pending"
    assert "payment=complete" in client.get("/checkout/return?token=ORDER-1").location
    assert client.get("/api/dashboard").get_json()["expenses"][0]["status"] == "paid"


def test_payout_failure_does_not_create_a_fake_success(client, monkeypatch):
    confirm(client)
    row = expense(client, "40", "reimbursement")
    client.post(f"/api/expenses/{row['id']}/approve", json={"confirmed": True})

    class Gateway:
        def create_payout(self, *_):
            raise IntegrationError("Payouts is not enabled.")

    monkeypatch.setattr(lab, "PayPalSandbox", Gateway)
    response = client.post(f"/api/expenses/{row['id']}/pay")
    assert response.status_code == 503
    assert client.get("/api/dashboard").get_json()["expenses"][0]["status"] == "approved"


def test_model_quota_error_is_reported_safely(monkeypatch):
    monkeypatch.setenv("AI_BASE_URL", "https://model.example/v1")
    monkeypatch.setenv("AI_API_KEY", "secret-for-test")
    monkeypatch.setenv("AI_MODEL", "demo")

    class Response:
        status_code = 402

        def raise_for_status(self):
            raise requests.HTTPError(response=self)

    monkeypatch.setattr(requests, "post", lambda *_args, **_kwargs: Response())
    with pytest.raises(IntegrationError, match="HTTP 402") as exc:
        model_json("system", "prompt")
    assert "secret-for-test" not in str(exc.value)
