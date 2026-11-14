const $ = id => document.getElementById(id);

function renderStatus(status) {
  const box = $('status');
  box.className = status?.state || '';
  box.textContent = status ? `${status.state}: ${status.detail || ''}` : 'Not configured.';
}

async function load() {
  const { port, token, origins, status } = await chrome.storage.local.get(['port', 'token', 'origins', 'status']);
  if (port) $('port').value = port;
  if (token) $('token').value = token;
  $('origins').value = (origins || []).join('\n');
  renderStatus(status);
}

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  await chrome.storage.local.set({
    port: Number($('port').value) || 47823,
    token: $('token').value.trim(),
    origins: $('origins').value.split(/\s+/).map(o => o.trim()).filter(Boolean)
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) renderStatus(changes.status.newValue);
});

load();
