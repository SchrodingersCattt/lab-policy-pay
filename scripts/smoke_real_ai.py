"""Exercise a real AI policy extraction and local approval workflow."""
from pathlib import Path

from labpolicy.app import create_app

root = Path(__file__).resolve().parents[1]
app = create_app(root / ".local" / "smoke-real-ai")
app.config["TESTING"] = True
client = app.test_client()
notice = ("For the research lab, the total monthly expense budget is $500. "
          "Any single request above $75 requires principal investigator approval. "
          "A single expense must never exceed $200.")
parsed = client.post("/api/policy/parse", json={"notice": notice})
if parsed.status_code != 200:
    raise SystemExit(f"Model extraction failed: {parsed.get_json()}")
policy = parsed.get_json()
if any(policy.get(key) is None for key in ("budget", "approval_threshold", "max_single")):
    raise SystemExit(f"Model did not provide all evidenced rules: {policy.get('warnings')}")
policy["confirmed"] = True
confirmed = client.post("/api/policy/confirm", json=policy)
if confirmed.status_code != 201:
    raise SystemExit(f"Policy confirmation failed: {confirmed.get_json()}")
created = client.post("/api/expenses", json={"project": "Demo Lab", "description": "Synthetic test purchase",
                      "amount": "45.00", "kind": "purchase"})
if created.status_code != 201:
    raise SystemExit(f"Expense check failed: {created.get_json()}")
expense = created.get_json()
approved = client.post(f"/api/expenses/{expense['id']}/approve", json={"confirmed": True})
if approved.status_code != 200:
    raise SystemExit(f"Approval failed: {approved.get_json()}")
print(f"Real AI policy extraction and human approval succeeded: request={expense['id']}, status={approved.get_json()['status']}")
