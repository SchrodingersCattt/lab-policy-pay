# Ledger Lab — submission draft

**Tagline:** From research spending rules to reviewed, traceable sandbox payments.

## Inspiration

Research teams make spending decisions after the rules have arrived in a notice
and the receipt has landed somewhere else. Re-entering amounts and finding the
relevant rule creates avoidable work for researchers and reviewers.

## What it does

Ledger Lab turns an uploaded finance notice into a proposed monthly budget,
approval threshold and per-expense limit, with source quotations. A reviewer
checks and activates the rules in a table. Local OCR handles images and scanned
PDF pages; text PDFs are read directly. The same assistant can extract an amount and
item description from uploaded receipt text or images, again showing source quotations.
Fields remain editable; a changed value is not retained as supported by the
original quotation. Requests over the single-expense or remaining monthly limit
are blocked with the exact rule and excess amount shown, and eligible requests
require an explicit approval before payment.

The PayPal Sandbox Orders flow sends a buyer through approval and verifies the
capture for a sample supplier. PayPal Sandbox Payouts sends an employee
reimbursement; the ledger distinguishes submission, unclaimed, failed and
successful item states. The demonstration uses virtual sandbox funds only.

AG Grid Community makes the ledger searchable and sortable, lets a reviewer
select a request and export the current view as CSV. It brings the policy
decision, receipt evidence, approval and PayPal status together in one place.

## How we built it

Python and Flask provide a local API and SQLite ledger. Tesseract.js and PDF.js
read uploaded documents in the browser. The AI integration sends
synthetic notice and receipt text to `deepseek-v4.1-flash` through Bohrium's
OpenAI-compatible endpoint and validates quoted substrings before presenting
them for review. The payment integration calls PayPal Sandbox Orders v2 and
Payouts v1 from the server. The interface uses AG Grid Community, vanilla
JavaScript and CSS. The English narration is synthesized.

## Accomplishments and limits

We exercised real model extraction and verified an actual $0.10 Sandbox payout
through the app, including the matching item's `SUCCESS` status. Tests cover
approval and budget gates, unsupported evidence, interrupted payout handling,
the UTC month boundary, and PayPal status checks. This is a local single-user
prototype and requires configured model and
PayPal sandbox access. It is not a production finance or authorization system.

**Built with:** Python, Flask, SQLite, JavaScript, Tesseract.js, PDF.js, AG Grid Community,
PayPal Sandbox Orders, PayPal Sandbox Payouts, Bohrium, DeepSeek.

**Repository:** https://github.com/SchrodingersCattt/lab-policy-pay

**Video:** Pending YouTube upload.
