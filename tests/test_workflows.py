from __future__ import annotations

import pytest
import requests
import sqlite3
from labpolicy import app as lab
from labpolicy.integrations import IntegrationError, PayPalSandbox, model_json


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
    assert "RULE 03" in blocked["decision"]
    assert all(value in blocked["decision"] for value in ("$201.00", "$200.00", "$1.00"))
    first = expense(client, "200")
    assert client.post(f"/api/expenses/{first['id']}/approve", json={"confirmed": False}).status_code == 400
    assert client.post(f"/api/expenses/{first['id']}/approve", json={"confirmed": True}).get_json()["status"] == "approved"
    second = expense(client, "200")
    assert client.post(f"/api/expenses/{second['id']}/approve", json={"confirmed": True}).status_code == 200
    assert expense(client, "150")["status"] == "blocked"
    budget_block = expense(client, "110")
    assert "RULE 01" in budget_block["decision"] and "$10.00" in budget_block["decision"]
    assert client.get("/api/dashboard").get_json()["committed"] == "400.00"
    assert client.post(f"/api/expenses/{second['id']}/cancel").status_code == 200
    assert client.get("/api/dashboard").get_json()["committed"] == "200.00"
    confirm(client, budget="500", maximum="100")
    response = client.post(f"/api/expenses/{first['id']}/pay")
    assert response.status_code == 409
    dashboard = client.get("/api/dashboard").get_json()
    assert dashboard["committed"] == "0.00"
    blocked_again = next(row for row in dashboard["expenses"] if row["id"] == first["id"])
    assert blocked_again["policy_id"] == dashboard["policy"]["id"]
    assert "RULE 03" in blocked_again["decision"] and "$100.00" in blocked_again["decision"]


def test_reimbursement_waits_for_item_success(client, monkeypatch):
    confirm(client)
    request = expense(client, "40", "reimbursement")
    assert client.post(f"/api/expenses/{request['id']}/approve", json={"confirmed": True}).status_code == 200
    states = iter([{"batch_status": "SUCCESS", "item_status": "UNCLAIMED"},
                   {"batch_status": "SUCCESS", "item_status": "SUCCESS"}])

    class Gateway:
        def create_payout(self, reference, amount, receiver):
            return {"batch_id": "BATCH-1", "status": "PENDING"}

        def payout_status(self, batch, reference, **expected):
            assert expected == {"expected_amount": "40.00", "expected_receiver": "sb-test@personal.example.com"}
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

        def capture_order(self, order_id, reference, amount, *, may_capture=True):
            assert order_id == "ORDER-1" and reference == row["id"] and amount == "45.00"
            assert may_capture
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
    assert client.get("/api/dashboard").get_json()["expenses"][0]["status"] == "payout_submitting"
    assert client.post(f"/api/expenses/{row['id']}/cancel").status_code == 400


def test_receipt_extraction_and_edited_evidence(client, monkeypatch):
    source = "Lab Store\nItem: pipette tips\nTotal: $45.00"
    monkeypatch.setattr(lab, "model_json", lambda *_: {
        "amount": "45", "description": "pipette tips",
        "evidence": {"amount": "Total: $45.00", "description": "Item: pipette tips"},
    })
    extracted = client.post("/api/expenses/parse", json={"source": source}).get_json()
    assert extracted["amount"] == "45.00" and extracted["description"] == "pipette tips"
    confirm(client)
    created = client.post("/api/expenses", json={"kind": "purchase", "project": "Lab", "description": "pipette tips",
                           "amount": "47", "source": source, "source_evidence": extracted["evidence"]}).get_json()
    assert created["source_evidence"]["amount"] is None
    assert created["source_evidence"]["description"] == "Item: pipette tips"
    assert created["source_text"] == source
    monkeypatch.setattr(lab, "model_json", lambda *_: {"amount": "99", "description": "invented",
        "evidence": {"amount": "Total: $45.00", "description": "invented"}})
    unsupported = client.post("/api/expenses/parse", json={"source": source}).get_json()
    assert unsupported["amount"] is None and unsupported["description"] is None


def test_previous_month_request_cannot_spend_current_month_budget(client, tmp_path):
    confirm(client, budget="100", maximum="100")
    row = expense(client, "80")
    client.post(f"/api/expenses/{row['id']}/approve", json={"confirmed": True})
    with sqlite3.connect(tmp_path / "lab-policy.sqlite3") as conn:
        conn.execute("UPDATE expenses SET created_at=datetime('now','start of month','-1 day') WHERE id=?", (row['id'],))
    current = expense(client, "90")
    assert client.post(f"/api/expenses/{current['id']}/approve", json={"confirmed": True}).status_code == 200
    assert client.post(f"/api/expenses/{row['id']}/pay").status_code == 409
    assert client.get("/api/dashboard").get_json()["committed"] == "90.00"


def test_unknown_payout_can_only_retry_same_request(client, monkeypatch):
    confirm(client)
    row = expense(client, "40", "reimbursement")
    client.post(f"/api/expenses/{row['id']}/approve", json={"confirmed": True})
    calls = []
    class Gateway:
        def create_payout(self, *args):
            calls.append(args)
            if len(calls) == 1:
                raise IntegrationError("Response lost")
            return {"batch_id": "BATCH-1", "status": "PENDING"}
    monkeypatch.setattr(lab, "PayPalSandbox", Gateway)
    assert client.post(f"/api/expenses/{row['id']}/pay").status_code == 503
    assert client.post(f"/api/expenses/{row['id']}/cancel").status_code == 400
    assert client.get("/api/dashboard").get_json()["committed"] == "40.00"
    assert client.post(f"/api/expenses/{row['id']}/pay").get_json()["status"] == "payout_pending"
    assert calls[0] == calls[1]


def test_completed_checkout_can_be_reconciled_after_policy_changes(client, monkeypatch):
    confirm(client)
    row = expense(client, "150")
    client.post(f"/api/expenses/{row['id']}/approve", json={"confirmed": True})
    class Gateway:
        def create_order(self, *_):
            return {"id": "ORDER-1", "approval_url": "https://sandbox.example/approve"}
        def capture_order(self, order_id, reference, amount, *, may_capture=True):
            assert not may_capture  # PayPal reports this order was already completed.
            return {"capture_id": "CAPTURE-1"}
    monkeypatch.setattr(lab, "PayPalSandbox", Gateway)
    client.post(f"/api/expenses/{row['id']}/pay")
    confirm(client, maximum="100")
    assert "payment=complete" in client.get("/checkout/return?token=ORDER-1").location
    assert client.get("/api/dashboard").get_json()["expenses"][0]["status"] == "paid"


def test_gateway_refuses_new_capture_if_policy_changed(monkeypatch):
    gateway = PayPalSandbox()
    calls = []
    def upstream(method, path, **_kwargs):
        calls.append(method)
        return {"status": "APPROVED", "purchase_units": [{"custom_id": "request",
                "amount": {"currency_code": "USD", "value": "45.00"}}]}
    monkeypatch.setattr(gateway, "_request", upstream)
    with pytest.raises(IntegrationError, match="no longer permits capture"):
        gateway.capture_order("ORDER-1", "request", "45.00", may_capture=False)
    assert calls == ["GET"]


def test_gateway_rejects_payout_with_mismatched_amount_or_receiver(monkeypatch):
    gateway = PayPalSandbox()
    monkeypatch.setattr(gateway, "_request", lambda *_args, **_kwargs: {"batch_header": {"batch_status": "SUCCESS"},
        "items": [{"transaction_status": "SUCCESS", "payout_item": {"sender_item_id": "request",
        "receiver": "sb-test@personal.example.com", "amount": {"currency": "USD", "value": "40.00"}}}]})
    with pytest.raises(IntegrationError, match="amount does not match"):
        gateway.payout_status("BATCH-1", "request", expected_amount="45.00")
    with pytest.raises(IntegrationError, match="recipient does not match"):
        gateway.payout_status("BATCH-1", "request", expected_amount="40.00", expected_receiver="other@example.com")


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
