"""Send one explicitly requested, small PayPal Sandbox payout and inspect its item status."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv

from labpolicy.integrations import IntegrationError, PayPalSandbox

if "--execute" not in sys.argv:
    raise SystemExit("Pass --execute to send a USD 0.10 Sandbox payout. No live environment is supported.")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
receiver = os.getenv("PAYPAL_SANDBOX_BUYER_EMAIL", "")
if not receiver.lower().endswith(("@personal.example.com", "@business.example.com")):
    raise SystemExit("Configure a PayPal example-domain Sandbox recipient; no real email is accepted by this smoke test.")
reference = uuid4().hex
try:
    gateway = PayPalSandbox()
    result = gateway.create_payout(reference, "0.10", receiver)
    print("Sandbox payout batch submitted; batch status:", result["status"], flush=True)
    for _ in range(10):
        status = gateway.payout_status(result["batch_id"], reference)
        print("Batch status:", status["batch_status"], "item status:", status["item_status"] or "pending", flush=True)
        if status["item_status"] in {"SUCCESS", "FAILED", "DENIED", "RETURNED", "CANCELED", "BLOCKED", "UNCLAIMED"}:
            break
        time.sleep(3)
except IntegrationError as exc:
    raise SystemExit(f"Sandbox payout test failed: {exc}") from exc
