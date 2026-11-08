# Ledger Lab

Ledger Lab helps a research team turn written spending rules and receipt text
into reviewable expense requests. AI proposes policy limits and receipt fields
with quotations from their source. A person checks the text and confirms the
policy and each payment request. The app checks the confirmed single-expense
and monthly limits before creating a PayPal Sandbox order or reimbursement.

The activity ledger uses **AG Grid Community** for filtering, sorting, selecting
requests, and CSV export. A simple list is provided if the grid is unavailable.
PayPal Orders demonstrates checkout with the configured sandbox merchant;
Payouts demonstrates reimbursement to a sandbox personal account. A payout is
marked paid only when the matching PayPal item reports `SUCCESS` and its amount
and recipient match the approved request. The application uses the PayPal
Sandbox API only; no live payment endpoint is supported.

## Run and test

Requirements: Python 3.11, [uv](https://docs.astral.sh/uv/), Node.js 20+ and
npm. For real AI and PayPal calls, configure an OpenAI-compatible model endpoint
and a PayPal developer **Sandbox** app. The recording uses `deepseek-v4.1-flash`
through Bohrium's OpenAI-compatible API, PayPal Orders v2 and Payouts v1, and
AG Grid Community. Other compatible model endpoints may also work.

```bash
git clone https://github.com/SchrodingersCattt/lab-policy-pay.git
cd lab-policy-pay
uv sync --locked --extra dev --python 3.11
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` and replace
`.venv/bin/python` in the commands below with `.venv\Scripts\python.exe`.
Edit `.env` locally:

* Set `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` for your model service.
  Notice and receipt text are sent to that service. Use synthetic text only.
* Create or select a [PayPal Sandbox app](https://developer.paypal.com/dashboard/)
  and set its **sandbox** `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
* To test reimbursement, enable Payouts for that sandbox app and set
  `PAYPAL_SANDBOX_BUYER_EMAIL` to a sandbox personal account, or enter one in
  the form. The purchase flow additionally requires sandbox buyer approval.
* Set `APP_SECRET_KEY` to a long random value. `APP_BASE_URL` defaults to
  `http://127.0.0.1:50002` and must be reachable by the browser after checkout.

```bash
.venv/bin/python -m labpolicy.app
```

Open <http://127.0.0.1:50002>. Click **Extract policy with AI**, compare each
value with its quotation and activate the policy. In **New request**, optionally
open **Extract from a receipt**, paste text, extract and review the proposed
fields. Select a payment flow and submit the request. Select it in the ledger,
confirm approval, then initiate the sandbox payment. For a reimbursement,
refresh the payout status to see whether the item has actually succeeded.
Try an amount above $200 with the example policy to see a blocked request.

```bash
.venv/bin/python -m pytest -q
```

Automated tests mock external services. A real $0.10 Sandbox reimbursement was
also completed through the app and checked against the PayPal payout item.
The purchase flow uses a sample merchant belonging to the configured sandbox
app, not an arbitrary supplier. Sandbox Payouts availability depends on the app.

## Boundaries and recovery

This is a single-user local hackathon prototype, not a production accounting
system: it has no authentication, roles, multi-process locking, secure audit
log, OCR, or general document upload. Keep it bound to localhost and use only
fictional data and sandbox accounts. An exact quotation is a review aid, not a
guarantee that a model interpreted a document correctly. Unsupported or edited
values are not represented as supported by the original quotation.

Records live in `.local/lab-policy.sqlite3`. Budgets use the UTC month in which
the request was created. Requests awaiting approval or payment expire at the
month boundary and must be recreated. A submitted payout may settle later and
remains accounted for in its request month. If a payout response is lost, the
request stays reserved and cannot be cancelled; retrying uses the same PayPal
idempotency identifiers within 24 hours of request creation, subject to the active policy and month.
After that, reconcile with PayPal before creating another request. A checkout
already captured at PayPal can still be verified after a policy change; a new
capture is refused when the policy or month no longer permits it.

Never commit `.env`, keys, sandbox credentials, personal data or runtime
databases. Free judge access to the real external services must be arranged
through a confirmed appropriate channel; do not publish credentials in the
repository or an unverified submission field.

## License

MIT; see [LICENSE](LICENSE). AG Grid Community is a separate MIT-licensed
dependency installed by npm.
