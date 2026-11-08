"""Exercise the approved policy and a real sandbox reimbursement through the app."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from labpolicy.app import create_app

if "--execute" not in sys.argv:
    raise SystemExit("Pass --execute to submit a USD 0.10 Sandbox reimbursement through the app.")
root = Path(__file__).resolve().parents[1]
load_dotenv(root / ".env")
receiver = os.getenv("PAYPAL_SANDBOX_BUYER_EMAIL", "")
if not receiver.lower().endswith(("@personal.example.com", "@business.example.com")):
    raise SystemExit("A fictional PayPal example-domain Sandbox recipient is required.")
client = create_app(root / ".local" / "smoke-real-ai").test_client()
dashboard = client.get("/api/dashboard").get_json()
if not dashboard.get("policy"):
    raise SystemExit("Run the real-AI policy smoke first; a confirmed policy is required.")
created = client.post("/api/expenses", json={"project": "Demo Lab", "description": "Sandbox reimbursement test",
                      "amount": "0.10", "kind": "reimbursement", "recipient": receiver})
if created.status_code != 201 or created.get_json().get("status") != "review":
    raise SystemExit(f"Policy check failed: {created.get_json()}")
expense = created.get_json()
approved = client.post(f"/api/expenses/{expense['id']}/approve", json={"confirmed": True})
if approved.status_code != 200:
    raise SystemExit(f"Human approval failed: {approved.get_json()}")
sent = client.post(f"/api/expenses/{expense['id']}/pay")
if sent.status_code != 200:
    raise SystemExit(f"Sandbox payout submission failed: {sent.get_json()}")
print("Approved reimbursement submitted to PayPal Sandbox.", flush=True)
for _ in range(10):
    result = client.post(f"/api/expenses/{expense['id']}/refresh")
    if result.status_code != 200:
        raise SystemExit(f"Payout status check failed: {result.get_json()}")
    state = result.get_json()["status"]
    print("Application payout status:", state, flush=True)
    if state in {"paid", "failed", "unclaimed"}:
        break
    time.sleep(3)
if state != "paid":
    raise SystemExit("Sandbox payout has not yet reached a successful item status.")
