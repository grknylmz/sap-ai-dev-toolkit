// Evaluated in the WebGUI page; returns the raw screen as JSON.
// Identity: SAP GUI Scripting IDs embedded in UR `lsdata` (any value shaped {SID, Type}).
(() => {
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const sidOf = (d) => {
    if (!d || typeof d !== 'object') return null;
    for (const v of Object.values(d)) if (v && typeof v === 'object' && typeof v.SID === 'string') return v;
    return null;
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = (el) => (el?.innerText || '').replace(/\u00a0/g, ' ').trim();
  const labelFor = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((i) => text(document.getElementById(i))).filter(Boolean).join(' ');
      if (t) return t;
    }
    return el.getAttribute('aria-label') || el.title || '';
  };
  const page = (() => {
    if (document.getElementById('sap-user') && document.getElementById('sap-password')) return 'login';
    if (document.getElementById('delete-session-cb') || document.getElementById('SESSION_QUERY_CONTINUE_BUTTON')) return 'session_query';
    if (window.UCF_Automation && document.querySelector('[lsdata*="\\"SID\\""]')) return 'webgui';
    return 'other';
  })();
  const out = { page, title: document.title, url: location.origin + location.pathname, ready: document.readyState };
  if (page !== 'webgui') {
    out.text = text(document.body).slice(0, 1500);
    return out;
  }
  const controls = [];
  for (const el of document.querySelectorAll('[lsdata]')) {
    const d = parse(el.getAttribute('lsdata'));
    const s = sidOf(d);
    if (!s) continue;
    const input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
    const c = { sid: s.SID, type: s.Type || '', ct: el.getAttribute('ct') || '', id: el.id, visible: visible(el) };
    if (s.SubType) c.subtype = s.SubType;
    const label = labelFor(input || el);
    if (label) c.label = label;
    if (input) {
      if (input.type === 'password') c.password = true;
      else c.value = input.value;
      if (input.readOnly || input.disabled || input.getAttribute('aria-readonly') === 'true' || input.getAttribute('aria-disabled') === 'true') c.readonly = true;
      if (input.getAttribute('aria-required') === 'true') c.required = true;
    } else {
      const t = text(el);
      if (t) c.text = t.slice(0, 200);
    }
    const checked = el.getAttribute('aria-checked') ?? input?.getAttribute('aria-checked');
    if (checked !== null && checked !== undefined) c.checked = checked === 'true';
    if (el.getAttribute('aria-selected') !== null) c.selected = el.getAttribute('aria-selected') === 'true';
    if (el.getAttribute('aria-disabled') === 'true') c.disabled = true;
    if (c.ct === 'B') {
      if (typeof d[0] === 'string' && d[0]) c.text = d[0];
      if (typeof d[4] === 'string' && d[4].trim()) c.tooltip = d[4].trim();
      if (typeof d[18] === 'string' && d[18]) c.fkey = d[18];
    } else if (el.title) {
      c.tooltip = el.title;
    }
    if (Array.isArray(s.ColumnIDs)) c.columns = s.ColumnIDs;
    if (s.messageType) c.messageType = s.messageType;
    controls.push(c);
  }
  const sys = {};
  for (const el of document.querySelectorAll('[ct=POMNI][id^=sysInfoAreaMenuItemSAPITS_]')) {
    const d = parse(el.getAttribute('lsdata'));
    sys[el.id.replace('sysInfoAreaMenuItemSAPITS_', '')] = d ? d[13] : '';
  }
  const scroll = {};
  for (const el of document.querySelectorAll('[id$="-scrollV"]')) {
    const d = parse(el.getAttribute('lsdata'));
    if (d) scroll[el.id] = { first: d[0], page: d[3], total: d[10] };
  }
  out.sys = sys;
  out.scroll = scroll;
  out.status = text(document.getElementById('wnd[0]/sbar_msg')) || '';
  out.controls = controls;
  return out;
})()
