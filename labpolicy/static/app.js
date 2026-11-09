const $ = selector => document.querySelector(selector);
const notice = $('#notice');
const query = new URLSearchParams(window.location.search);
const policyFields = ['budget', 'approval_threshold', 'max_single'];
let parsedPolicy = null;
let activePolicy = null;
let parsedReceipt = null;
let selected = null;
let gridApi = null;
let ocrWorker = null;
let ocrProgress = () => {};
let uploadedPreviewUrl = null;

function flash(message, error = false) {
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle('error', error);
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}
function post(url, data = {}) {
  return api(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
}
function formatUSD(value) { return `$${value}`; }

function initGrid() {
  if (!window.agGrid?.createGrid) {
    $('#expense-grid').hidden = true;
    $('#fallback-table').hidden = false;
    return;
  }
  gridApi = agGrid.createGrid($('#expense-grid'), {
    columnDefs: [
      {field: 'project', headerName: 'PROJECT', minWidth: 140, flex: 1},
      {field: 'description', headerName: 'REQUEST', minWidth: 190, flex: 2},
      {field: 'kind', headerName: 'TYPE', minWidth: 130, flex: 1},
      {field: 'amount', headerName: 'USD', width: 105, valueFormatter: p => formatUSD(p.value)},
      {field: 'status', headerName: 'STATUS', minWidth: 145, flex: 1}
    ],
    defaultColDef: {sortable: true, filter: true, resizable: true},
    rowData: [], onRowClicked: event => selectExpense(event.data), suppressCellFocus: true
  });
  $('#grid-label').textContent = 'AG GRID COMMUNITY';
  $('#grid-tools').hidden = false;
}

function fallbackRows(rows) {
  const host = $('#fallback-table');
  host.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary';
    button.textContent = `${row.project} · ${row.description} · $${row.amount} · ${row.status}`;
    button.addEventListener('click', () => selectExpense(row));
    host.append(button);
  }
}

function showRules(policy, editable) {
  $('#policy-review').hidden = false;
  $('#rules-status').textContent = editable ? 'READY TO REVIEW' : 'ACTIVE';
  $('#confirm-policy').hidden = !editable;
  $('#edit-policy').hidden = editable;
  for (const key of policyFields) {
    const input = $(`#${key}`);
    input.value = policy[key] || '';
    input.readOnly = !editable;
    const quote = policy.evidence?.[key];
    $(`#${key}-evidence`).textContent = quote ? `“${quote}”` : 'Entered by reviewer';
  }
  highlightRules(selected);
}

function highlightRules(row) {
  const decision = !parsedPolicy && row?.status === 'blocked' && row.policy_id === activePolicy?.id ? row.decision : '';
  for (const [key, code] of [['budget', 'RULE 01'], ['approval_threshold', 'RULE 02'], ['max_single', 'RULE 03']]) {
    $(`#rule-${key}`).classList.toggle('rule-violated', decision.includes(code));
  }
}

function selectExpense(row) {
  selected = row;
  $('#selected').hidden = false;
  $('#selected').classList.toggle('is-blocked', row.status === 'blocked');
  $('#selected-title').textContent = `${row.project} · $${row.amount}`;
  $('#selected-state').textContent = row.status.replaceAll('_', ' ').toUpperCase();
  $('#selected-decision').textContent = row.decision;
  const quotes = row.source_evidence || {};
  const source = [];
  if (row.recipient_label) source.push(`Sandbox recipient: ${row.recipient_label}`);
  if (row.source_text) source.push(`Receipt: ${row.source_text}`);
  if (quotes.amount) source.push(`Amount source: “${quotes.amount}”`);
  if (quotes.description) source.push(`Description source: “${quotes.description}”`);
  $('#selected-source').textContent = source.join(' · ');
  $('#selected-source').hidden = !source.length;
  $('#approve').hidden = row.status !== 'review';
  $('#pay').hidden = !['approved', 'payout_submitting'].includes(row.status);
  $('#pay').textContent = row.status === 'payout_submitting' ? 'Retry same sandbox payout' :
    row.kind === 'purchase' ? 'Continue to sandbox checkout' : 'Send sandbox reimbursement';
  $('#refresh').hidden = !['payout_pending', 'unclaimed'].includes(row.status);
  $('#cancel').hidden = !['review', 'approved'].includes(row.status);
  highlightRules(row);
}

async function refreshDashboard() {
  const data = await api('/api/dashboard');
  activePolicy = data.policy;
  $('#policy-badge').textContent = activePolicy ? 'Active & confirmed' : 'Not active';
  $('#metric-budget').textContent = activePolicy ? formatUSD(activePolicy.budget) : '—';
  $('#metric-committed').textContent = formatUSD(data.committed);
  $('#metric-remaining').textContent = activePolicy ? formatUSD(data.remaining) : '—';
  if (!parsedPolicy && activePolicy) showRules(activePolicy, false);
  $('#empty-ledger').hidden = !!data.expenses.length;
  $('#expense-grid').hidden = !data.expenses.length || !gridApi;
  $('#fallback-table').hidden = !data.expenses.length || !!gridApi;
  if (gridApi) gridApi.setGridOption('rowData', data.expenses); else fallbackRows(data.expenses);
  const wanted = selected?.id || query.get('select');
  if (wanted) {
    const next = data.expenses.find(item => item.id === wanted);
    if (next) selectExpense(next);
  }
}

async function getOcrWorker(progress) {
  ocrProgress = progress;
  if (!ocrWorker) {
    if (!window.Tesseract?.createWorker) throw new Error('OCR assets are unavailable. Run npm ci to install them.');
    ocrWorker = await Tesseract.createWorker(['eng', 'chi_sim'], 1, {
      workerPath: new URL('/vendor/ocr/tesseract/worker.min.js', location.origin).href,
      corePath: new URL('/vendor/ocr/core', location.origin).href,
      langPath: new URL('/vendor/tessdata', location.origin).href,
      workerBlobURL: false,
      logger: message => {
        if (message.status === 'recognizing text') ocrProgress(`Recognizing text… ${Math.round(message.progress * 100)}%`);
      }
    });
  }
  return ocrWorker;
}

async function recognizeImage(image, progress) {
  const worker = await getOcrWorker(progress);
  const result = await worker.recognize(image);
  return result.data.text.trim();
}

async function readDocument(file, progress) {
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose a file smaller than 15 MB.');
  const name = file.name.toLowerCase();
  if (file.type === 'text/plain' || name.endsWith('.txt')) {
    return {text: (await file.text()).trim(), method: 'Text file'};
  }
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    progress('Reading PDF…');
    const pdfjs = await import('/vendor/ocr/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/ocr/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
    try {
      if (pdf.numPages > 8) throw new Error('Choose a PDF with eight pages or fewer.');
      const pages = [];
      let usedOcr = false;
      let preview = null;
      for (let number = 1; number <= pdf.numPages; number++) {
        progress(`Reading page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = content.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
        if (text.replace(/\s+/gu, '').length < 30) {
          const viewport = page.getViewport({scale: 2});
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
          if (number === 1) preview = canvas.toDataURL('image/png');
          text = await recognizeImage(canvas, progress);
          usedOcr = true;
        } else if (number === 1) {
          const viewport = page.getViewport({scale: 1.25});
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({canvas, canvasContext: canvas.getContext('2d'), viewport}).promise;
          preview = canvas.toDataURL('image/png');
        }
        pages.push(text);
      }
      return {text: pages.filter(Boolean).join('\n\n'), method: usedOcr ? 'PDF text and local OCR' : 'PDF text extracted', preview};
    } finally {
      await pdf.destroy();
    }
  }
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)) {
    progress('Preparing local OCR…');
    return {text: await recognizeImage(file, progress), method: 'Local OCR', preview: file};
  }
  throw new Error('Choose a PDF, image, or text file.');
}

async function uploadDocument(file, target) {
  const isPolicy = target === 'policy';
  const status = $(isPolicy ? '#policy-upload-status' : '#receipt-upload-status');
  const field = $(isPolicy ? '#policy-text' : '#receipt-text');
  const inputs = [$('#policy-file'), $('#receipt-file')];
  const controls = [$('#upload-policy'), $('#upload-receipt')];
  const extractButton = $(isPolicy ? '#parse-policy' : '#parse-receipt');
  const progress = message => { status.hidden = false; status.textContent = message; };
  inputs.forEach(input => { input.disabled = true; });
  controls.forEach(button => { button.disabled = true; });
  extractButton.disabled = true;
  try {
    progress('Reading document…');
    const result = await readDocument(file, progress);
    if (!result.text) throw new Error('No text was found in this document.');
    field.value = result.text;
    field.dispatchEvent(new Event('input', {bubbles: true}));
    if (isPolicy) {
      $('#example-document').hidden = true;
      $('#uploaded-document').hidden = false;
      $('#reset-sample').hidden = false;
      $('#uploaded-filename').textContent = file.name;
      $('#uploaded-method').textContent = result.method;
      if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
      uploadedPreviewUrl = result.preview instanceof Blob ? URL.createObjectURL(result.preview) : null;
      $('#uploaded-preview-wrap').hidden = !result.preview;
      if (result.preview) $('#uploaded-preview').src = uploadedPreviewUrl || result.preview;
      $('#policy-source-details').open = true;
    }
    progress(`${result.method} complete · ${result.text.length} characters`);
    if (result.text.length > 8000) progress('Document text exceeds 8,000 characters. Edit it before extraction.');
  } catch (error) {
    progress(error.message || 'Could not read this document.');
    flash(error.message || 'Could not read this document.', true);
  } finally {
    inputs.forEach(input => { input.disabled = false; input.value = ''; });
    controls.forEach(button => { button.disabled = false; });
    extractButton.disabled = false;
  }
}

const exampleText = $('#policy-text').value;
function downloadExample() {
  const canvas = document.createElement('canvas');
  canvas.width = 1800; canvas.height = 2200;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2); ctx.fillStyle = '#fffefa'; ctx.fillRect(0, 0, 900, 1100);
  const font = (size, weight = 'normal') => `${weight} ${size}px DengXian, 等线, sans-serif`;
  const line = (text, x, y, size, color, weight) => { ctx.font = font(size, weight); ctx.fillStyle = color; ctx.fillText(text, x, y); };
  const paragraph = (text, x, y, maxWidth) => {
    ctx.font = font(18); ctx.fillStyle = '#263b35';
    let row = '';
    for (const word of text.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && row) { ctx.fillText(row, x, y); y += 33; row = word; }
      else row = next;
    }
    if (row) ctx.fillText(row, x, y);
    return y + 58;
  };
  line('INSTITUTE FOR RESEARCH', 76, 95, 18, '#345c4d', 'bold');
  line('Office of Research Finance', 76, 125, 14, '#627a6c');
  ctx.strokeStyle = '#a65342'; ctx.lineWidth = 1.5; ctx.strokeRect(700, 72, 110, 40);
  line('AI DEMO', 713, 98, 14, '#a65342', 'bold');
  ctx.fillStyle = '#4c7562'; ctx.fillRect(76, 153, 748, 3);
  line('FINANCE POLICY NOTICE', 76, 193, 14, '#72877c', 'bold');
  line('RF-2026-11', 720, 193, 14, '#72877c', 'bold');
  line('Research Expense Policy', 76, 250, 30, '#1e4435', 'bold');
  line('To: Principal Investigators and Research Staff', 76, 300, 14, '#263b35');
  line('Date: 1 November 2026', 76, 327, 14, '#263b35');
  let y = 395;
  y = paragraph('Effective immediately, the monthly expense budget for each research lab is $500.', 76, y, 748);
  y = paragraph('Any single request above $75 requires principal investigator approval.', 76, y, 748);
  y = paragraph('A single expense must never exceed $200.', 76, y, 748);
  line('Office of Research Finance', 76, y + 32, 18, '#4d6c5b', 'bold');
  canvas.toBlob(blob => {
    if (!blob) { flash('Could not create the example document.', true); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'ledger-lab-policy-ai-demo.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

$('#upload-policy').addEventListener('click', () => $('#policy-file').click());
$('#upload-receipt').addEventListener('click', () => $('#receipt-file').click());
$('#policy-file').addEventListener('change', event => { if (event.target.files[0]) uploadDocument(event.target.files[0], 'policy'); });
$('#receipt-file').addEventListener('change', event => { if (event.target.files[0]) uploadDocument(event.target.files[0], 'receipt'); });
$('#download-sample').addEventListener('click', downloadExample);
$('#reset-sample').addEventListener('click', () => {
  $('#example-document').hidden = false; $('#uploaded-document').hidden = true; $('#reset-sample').hidden = true;
  $('#uploaded-preview-wrap').hidden = true;
  $('#uploaded-preview').removeAttribute('src');
  if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
  uploadedPreviewUrl = null;
  $('#policy-upload-status').hidden = true; $('#policy-text').value = exampleText;
  $('#policy-text').dispatchEvent(new Event('input', {bubbles: true}));
  $('#policy-source-details').open = false;
});

$('#parse-policy').addEventListener('click', async () => {
  const button = $('#parse-policy'); button.disabled = true; button.firstElementChild.textContent = 'Extracting policy…';
  try {
    parsedPolicy = await post('/api/policy/parse', {notice: $('#policy-text').value});
    showRules(parsedPolicy, true);
    flash(parsedPolicy.warnings.length ? parsedPolicy.warnings.join(' ') : 'Policy rules extracted. Review and confirm them below.');
    $('#policy-review').scrollIntoView({behavior: 'smooth', block: 'nearest'});
  } catch (error) { flash(error.message, true); }
  finally { button.disabled = false; button.firstElementChild.textContent = 'Extract policy with AI'; }
});

$('#confirm-policy').addEventListener('click', async () => {
  if (!parsedPolicy) return;
  try {
    await post('/api/policy/confirm', {notice: parsedPolicy.notice, evidence: parsedPolicy.evidence, confirmed: true,
      budget: $('#budget').value, approval_threshold: $('#approval_threshold').value, max_single: $('#max_single').value});
    parsedPolicy = null;
    await refreshDashboard();
    flash('Policy rules confirmed and active.');
  } catch (error) { flash(error.message, true); }
});
$('#policy-text').addEventListener('input', () => {
  parsedPolicy = null;
  if (activePolicy) showRules(activePolicy, false); else $('#policy-review').hidden = true;
});
for (const key of policyFields) {
  $(`#${key}`).addEventListener('input', () => {
    if (!parsedPolicy) return;
    const same = parsedPolicy[key] && Number($(`#${key}`).value) === Number(parsedPolicy[key]);
    $(`#${key}-evidence`).textContent = same && parsedPolicy.evidence[key] ? `“${parsedPolicy.evidence[key]}”` : 'Edited by reviewer';
  });
}
$('#edit-policy').addEventListener('click', () => {
  if (!activePolicy) return;
  parsedPolicy = {...activePolicy}; $('#policy-text').value = activePolicy.notice;
  showRules(parsedPolicy, true);
});

function updateRecipient() {
  const reimbursement = $('#kind').value === 'reimbursement', configured = $('#use-configured-recipient').checked;
  $('#recipient-wrap').hidden = !reimbursement; $('#recipient').required = reimbursement && !configured; $('#recipient').disabled = configured;
}
$('#kind').addEventListener('change', updateRecipient);
$('#use-configured-recipient').addEventListener('change', updateRecipient);
$('#receipt-text').addEventListener('input', () => { parsedReceipt = null; $('#receipt-evidence').textContent = ''; });
$('#parse-receipt').addEventListener('click', async () => {
  const button = $('#parse-receipt'); button.disabled = true; button.firstElementChild.textContent = 'Reading receipt…';
  try {
    parsedReceipt = await post('/api/expenses/parse', {source: $('#receipt-text').value});
    if (parsedReceipt.amount) $('#amount').value = parsedReceipt.amount;
    if (parsedReceipt.description) $('#description').value = parsedReceipt.description;
    const evidence = parsedReceipt.evidence;
    $('#receipt-evidence').textContent = [evidence.amount && `Amount: “${evidence.amount}”`, evidence.description && `Description: “${evidence.description}”`].filter(Boolean).join(' · ') || 'No fields found. Enter them manually.';
    flash('Receipt fields extracted. Review the amount and description.');
  } catch (error) { flash(error.message, true); }
  finally { button.disabled = false; button.firstElementChild.textContent = 'Extract receipt with AI'; }
});
$('#expense-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const row = await post('/api/expenses', {kind: $('#kind').value, project: $('#project').value, amount: $('#amount').value,
      description: $('#description').value, recipient: $('#recipient').value, use_configured_recipient: $('#use-configured-recipient').checked,
      source: $('#receipt-text').value, source_evidence: parsedReceipt?.evidence || {}});
    selected = row; await refreshDashboard(); selectExpense(row);
    flash(row.status === 'blocked' ? row.decision : 'Request checked. Review the decision and confirm it.', row.status === 'blocked');
    $('#activity').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) { flash(error.message, true); }
});
$('#approve').addEventListener('click', async () => { if (!selected) return; try { selected = await post(`/api/expenses/${selected.id}/approve`, {confirmed: true}); await refreshDashboard(); flash('Approved. The amount is reserved.'); } catch (error) { flash(error.message, true); await refreshDashboard(); } });
$('#pay').addEventListener('click', async () => { if (!selected) return; try { const result = await post(`/api/expenses/${selected.id}/pay`); if (result.approval_url) window.location.assign(result.approval_url); else { await refreshDashboard(); flash('Sandbox payout submitted. Refresh its item status.'); } } catch (error) { await refreshDashboard(); flash(error.message, true); } });
$('#refresh').addEventListener('click', async () => { if (!selected) return; try { selected = await post(`/api/expenses/${selected.id}/refresh`); await refreshDashboard(); flash('Payout status refreshed from PayPal Sandbox.'); } catch (error) { flash(error.message, true); } });
$('#cancel').addEventListener('click', async () => { if (!selected) return; try { selected = await post(`/api/expenses/${selected.id}/cancel`); await refreshDashboard(); flash('Request cancelled.'); } catch (error) { flash(error.message, true); } });

initGrid();
$('#grid-search').addEventListener('input', event => gridApi?.setGridOption('quickFilterText', event.target.value));
$('#grid-export').addEventListener('click', () => gridApi?.exportDataAsCsv({fileName: 'ledger-lab-requests.csv', processCellCallback: params => {
  const value = String(params.value ?? ''); return /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
}}));
refreshDashboard().catch(error => flash(error.message, true));
const payment = query.get('payment');
if (payment === 'complete') flash('PayPal sandbox capture verified and recorded.');
if (payment === 'cancelled') flash('Checkout cancelled. The request remains approved.');
if (payment === 'failed') flash('The sandbox payment could not be verified.', true);
