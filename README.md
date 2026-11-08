# Ledger Lab

Ledger Lab turns a research finance notice into a human-confirmed expense policy
and applies it before a sandbox purchase or reimbursement. AI extracts three
amounts with quotations from the original notice; a person reviews and
activates them. A person then approves each eligible request before any payment
is initiated. Requests exceeding the confirmed single-expense or monthly limit
are blocked.

The demo integrates PayPal Sandbox Orders and Payouts. The purchase scenario
uses a sample merchant belonging to the configured sandbox app; it does not
claim to pay arbitrary external merchants. Reimbursement requires Payouts to
be enabled on the sandbox app and uses a sandbox personal-account recipient.
A submitted payout is not shown as paid until its **item** reports success.
No live PayPal payment is used or supported.

## Run locally

Requirements: Python 3.11+, `uv`, Node.js 20+, an OpenAI-compatible model
endpoint and PayPal developer sandbox credentials.

```bash
uv sync --locked --extra dev --python 3.11
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
```

On Windows use `.venv\Scripts\python`. Fill in the AI endpoint, model and
API key, the **Sandbox** PayPal client ID and secret, and a random
`APP_SECRET_KEY` in `.env`. `APP_BASE_URL` must be reachable by the browser
after PayPal approval; the local default is `http://127.0.0.1:50002`.

```bash
.venv/bin/python -m labpolicy.app
```

Open <http://127.0.0.1:50002>. Extract the example notice, review the values
and confirm the policy. Create a purchase or reimbursement, inspect the
decision, and approve it as a person. For a purchase, approve the order with a
PayPal sandbox buyer account. For a reimbursement, enter a sandbox personal
account email and refresh the payout item status after submission.

AG Grid Community is optional: if its local dependency is missing, the app
shows a basic request list. The npm dependency is MIT licensed. Records and
budget reservations live in `.local/lab-policy.sqlite3` and are calculated
for the current UTC calendar month. All notice and expense examples should be
synthetic. This is a single-user local demo, not a production finance system.

## Tests and credentials

```bash
.venv/bin/python -m pytest
```

The tests mock external services and cannot replace a real sandbox end-to-end
test. Do not commit `.env`, sandbox secrets, personal financial records or
model API keys. Free judge access to the model and sandbox must be arranged
before submission.
