const $ = selector => document.querySelector(selector);
const notice = $('#notice');
let parsedPolicy = null;
let selected = null;
let gridApi = null;
let currentExpenses = [];

function flash(message, error = false) { notice.textContent = message; notice.hidden = false; notice.classList.toggle('error', error); }
async function api(url, options = {}) {
  const response = await fetch(url, options); const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}
function post(url, data = {}) { return api(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}); }
function formatUSD(value) { return `$${value}`; }

function initGrid() {
  if (!window.agGrid?.createGrid) { $('#expense-grid').hidden = true; $('#fallback-table').hidden = false; return; }
  gridApi = agGrid.createGrid($('#expense-grid'), {
    columnDefs:[
      {field:'project', headerName:'PROJECT', minWidth:140, flex:1},
      {field:'description', headerName:'REQUEST', minWidth:190, flex:2},
      {field:'kind', headerName:'TYPE', minWidth:130, flex:1},
      {field:'amount', headerName:'USD', width:95, valueFormatter:p=>formatUSD(p.value)},
      {field:'status', headerName:'STATUS', minWidth:145, flex:1}
    ],
    defaultColDef:{sortable:true, filter:true, resizable:true},
    rowData:[], onRowClicked:event=>selectExpense(event.data),
    suppressCellFocus:true
  });
  $('#grid-label').textContent = 'AG GRID COMMUNITY';
}

function fallbackRows(rows) {
  const host = $('#fallback-table'); host.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button'); button.type='button'; button.className='secondary';
    button.textContent = `${row.project} · ${row.description} · $${row.amount} · ${row.status}`;
    button.addEventListener('click', ()=>selectExpense(row)); host.append(button);
  }
}

function selectExpense(row) {
  selected = row; $('#selected').hidden = false;
  $('#selected-title').textContent = `${row.project} · $${row.amount}`;
  $('#selected-state').textContent = row.status.replaceAll('_',' ').toUpperCase();
  $('#selected-decision').textContent = row.decision;
  $('#approve').hidden = row.status !== 'review';
  $('#pay').hidden = row.status !== 'approved';
  $('#pay').textContent = row.kind === 'purchase' ? 'Continue to sandbox checkout' : 'Send sandbox reimbursement';
  $('#refresh').hidden = !['payout_pending','unclaimed'].includes(row.status);
  $('#cancel').hidden = !['review','approved'].includes(row.status);
}

async function refreshDashboard() {
  const data = await api('/api/dashboard');
  const policy = data.policy;
  $('#policy-badge').textContent = policy ? 'Active & confirmed' : 'Not active';
  $('#metric-budget').textContent = policy ? formatUSD(policy.budget) : '—';
  $('#metric-committed').textContent = formatUSD(data.committed);
  $('#metric-remaining').textContent = policy ? formatUSD(data.remaining) : '—';
  $('#active-policy').hidden = !policy;
  currentExpenses = data.expenses;
  $('#empty-ledger').hidden = !!data.expenses.length;
  $('#expense-grid').hidden = !data.expenses.length || !gridApi;
  $('#fallback-table').hidden = !data.expenses.length || !!gridApi;
  if (gridApi) gridApi.setGridOption('rowData', data.expenses); else fallbackRows(data.expenses);
  if (selected) { const next = data.expenses.find(x=>x.id === selected.id); if(next) selectExpense(next); }
}

$('#parse-policy').addEventListener('click', async () => {
  const button = $('#parse-policy'); button.disabled = true; button.firstElementChild.textContent = 'Extracting policy…';
  try {
    parsedPolicy = await post('/api/policy/parse', {notice:$('#policy-text').value});
    for (const key of ['budget','approval_threshold','max_single']) {
      $(`#${key}`).value = parsedPolicy[key] || '';
      $(`#${key}-evidence`).textContent = parsedPolicy.evidence[key] ? `Source: “${parsedPolicy.evidence[key]}”` : 'No exact source found — enter and verify this amount.';
    }
    $('#policy-review').hidden = false;
    flash(parsedPolicy.warnings.length ? parsedPolicy.warnings.join(' ') : 'Review the extracted rules before confirming.');
  } catch(error) { flash(error.message, true); }
  finally { button.disabled = false; button.firstElementChild.textContent = 'Extract policy with AI'; }
});

$('#confirm-policy').addEventListener('click', async () => {
  if (!parsedPolicy) return;
  try {
    await post('/api/policy/confirm', {notice:parsedPolicy.notice, evidence:parsedPolicy.evidence, confirmed:true,
      budget:$('#budget').value, approval_threshold:$('#approval_threshold').value, max_single:$('#max_single').value});
    $('#policy-review').hidden = true; await refreshDashboard(); flash('Policy activated after human confirmation.');
  } catch(error) { flash(error.message, true); }
});
$('#edit-policy').addEventListener('click', ()=>{ if(parsedPolicy) $('#policy-review').hidden = false; else flash('Extract the notice to review a new policy.'); });
$('#kind').addEventListener('change', ()=>{ const reimbursement=$('#kind').value==='reimbursement'; $('#recipient-wrap').hidden=!reimbursement; $('#recipient').required=reimbursement; });
$('#expense-form').addEventListener('submit', async event=>{
  event.preventDefault();
  try {
    const row = await post('/api/expenses', {kind:$('#kind').value, project:$('#project').value, amount:$('#amount').value,
      description:$('#description').value, recipient:$('#recipient').value});
    selected=row; await refreshDashboard(); selectExpense(row);
    flash(row.status==='blocked' ? row.decision : 'Request checked. Review the decision and confirm it as a person.', row.status==='blocked');
    $('#activity').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) { flash(error.message, true); }
});
$('#approve').addEventListener('click', async ()=>{ if(!selected)return; try{ selected=await post(`/api/expenses/${selected.id}/approve`,{confirmed:true}); await refreshDashboard(); flash('Approved. The amount is reserved; payment has not yet been sent.'); }catch(error){flash(error.message,true);await refreshDashboard();} });
$('#pay').addEventListener('click', async ()=>{ if(!selected)return; try{ const result=await post(`/api/expenses/${selected.id}/pay`); if(result.approval_url) window.location.assign(result.approval_url); else {await refreshDashboard();flash('Sandbox payout submitted. Refresh its item status to confirm delivery.');} }catch(error){flash(error.message,true);} });
$('#refresh').addEventListener('click', async ()=>{ if(!selected)return; try{ selected=await post(`/api/expenses/${selected.id}/refresh`); await refreshDashboard(); flash('Payout status refreshed from PayPal Sandbox.'); }catch(error){flash(error.message,true);} });
$('#cancel').addEventListener('click', async ()=>{ if(!selected)return; try{ selected=await post(`/api/expenses/${selected.id}/cancel`); await refreshDashboard(); flash('Request cancelled before payment.'); }catch(error){flash(error.message,true);} });

initGrid();
refreshDashboard().catch(error=>flash(error.message,true));
const payment = new URLSearchParams(window.location.search).get('payment');
if(payment==='complete') flash('PayPal sandbox capture verified and recorded.');
if(payment==='cancelled') flash('Checkout cancelled. The request remains approved.');
if(payment==='failed') flash('The sandbox payment could not be verified.',true);
