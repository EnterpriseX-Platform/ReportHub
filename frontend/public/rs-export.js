/*!
 * rs-export.js — Report Studio export button/drawer for host web apps.
 *
 * Served BY Report Studio (public/ -> {basePath}/rs-export.js, e.g.
 * https://reports.example.com/reportstudio/rs-export.js) so every consuming project
 * includes one URL and picks up fixes without re-vendoring the file.
 *
 *   <script src="https://reports.example.com/reportstudio/rs-export.js"></script>
 *   <script>
 *     RSExport.configure({ apiBase: 'https://reports.example.com/reportstudio/api' });
 *     RSExport.mount({
 *       target: '#exportBtnHost',
 *       reportCode: 'SALES_RPT01_XLSX',
 *       permission: { componentId: 'sales.export' },
 *       defaults: { PARAM_A: 'value' },
 *       hidden: ['role']          // supplied by the page, never shown in the drawer
 *     });
 *   </script>
 *
 * AUTH (edge auth): no token is handled here. Requests go out with
 * credentials:'include' so the gateway's oauth2-proxy session cookie rides along;
 * the edge injects the verified access token as X-Forwarded-Access-Token and
 * Report Studio's EdgeBearerAuthFilter JWKS-verifies it -> the report runs AS THE REAL
 * USER (job.requestedBy). Projects not behind the edge can pass configure({getToken}).
 *
 * DEPENDENCIES: none. Plain DOM + fetch, own CSS, own markup — so it works in
 * template-based apps and Angular/React apps alike.
 */
(function (global) {
  'use strict';

  // index.html load-order hazard: a hard re-declare of an existing global breaks the
  // rest of the including script. Never clobber an already-loaded copy.
  if (global.RSExport) return;

  var CFG = {
    apiBase: '/reportstudio/api',
    credentials: 'include',   // carries the edge session cookie
    getToken: null,           // optional: () => string | Promise<string> (non-edge projects)
    pollMs: 1500,
    firstPollMs: 700,
    pollTimeoutMs: 20 * 60 * 1000, // matches Report Studio's own render job cap
    historyKey: 'rs.export.jobs',
    historyLimit: 15,
    hasComponent: null,       // optional: (componentId) => boolean — host page-permission check
    getRoles: null            // optional: () => string[] — the signed-in user's role codes
  };

  function configure(o) { for (var k in (o || {})) if (o[k] !== undefined) CFG[k] = o[k]; return CFG; }

  // ── http ──────────────────────────────────────────────────────────────────────
  function authHeaders() {
    if (typeof CFG.getToken !== 'function') return Promise.resolve({});
    return Promise.resolve(CFG.getToken()).then(function (t) {
      return t ? { Authorization: 'Bearer ' + t } : {};
    });
  }

  function req(path, opts) {
    opts = opts || {};
    return authHeaders().then(function (extra) {
      var headers = { Accept: 'application/json' };
      for (var k in extra) headers[k] = extra[k];
      for (var h in (opts.headers || {})) headers[h] = opts.headers[h];
      return fetch(CFG.apiBase + path, {
        method: opts.method || 'GET',
        credentials: CFG.credentials,
        headers: headers,
        body: opts.body
      });
    });
  }

  function json(path, opts) {
    return req(path, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw httpError(r.status, t); });
      return r.status === 204 ? null : r.json();
    });
  }

  function httpError(status, body) {
    var msg = status === 401 ? 'Unauthorized (401) — session expired or not signed in'
            : status === 403 ? 'Forbidden (403)'
            : status === 404 ? 'Not found (404)'
            : 'Report Studio request failed (' + status + ')';
    try { var j = JSON.parse(body); if (j && j.message) msg += ' — ' + j.message; } catch (e) { /* plain text body */ }
    var err = new Error(msg); err.status = status; return err;
  }

  /**
   * POST a JSON body. Some WAFs 403 bodies containing anything it reads as
   * SQL-ish (documented in reportstudio-external-api.yaml); Report Studio accepts the same
   * body base64-wrapped, so retry that way once rather than failing the user's export.
   */
  function postJson(path, obj) {
    var raw = JSON.stringify(obj);
    return req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
      .then(function (r) {
        if (r.status !== 403) return r;
        return req(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Body-Encoding': 'base64' },
          body: b64(raw)
        });
      })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw httpError(r.status, t); });
        return r.json();
      });
  }

  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }

  var api = {
    report: function (code) { return json('/reports/' + encodeURIComponent(code)); },
    params: function (code) { return json('/reports/' + encodeURIComponent(code) + '/parameters'); },
    options: function (name, parent) {
      return json('/parameters/' + encodeURIComponent(name) + '/options'
        + (parent ? '?parent=' + encodeURIComponent(parent) : ''));
    },
    run: function (code, body) { return postJson('/reports/' + encodeURIComponent(code) + '/run', body); },
    job: function (id) { return json('/jobs/' + encodeURIComponent(id)); },
    download: function (id) { return req('/jobs/' + encodeURIComponent(id) + '/output/download'); }
  };

  // ── permissions ───────────────────────────────────────────────────────────────
  /**
   * Who may SEE the button, using the hasComponent / getRoles hooks passed to configure().
   * Fail-open by design: this only hides
   * UI — Report Studio still authorises every call against the verified edge token, so a
   * user who un-hides the button cannot run anything they aren't entitled to.
   */
  function allowed(p) {
    if (!p) return true;
    try {
      if (typeof p.can === 'function') return !!p.can();
      if (p.componentId && typeof CFG.hasComponent === 'function') return !!CFG.hasComponent(p.componentId);
      if (p.roles && p.roles.length) {
        var mine = (typeof CFG.getRoles === 'function' && CFG.getRoles()) || [];
        return p.roles.some(function (r) { return mine.indexOf(r) >= 0; });
      }
    } catch (e) { return true; }
    return true;
  }

  // ── job history (so a slow render can be picked up later) ─────────────────────
  function history() {
    try { return JSON.parse(global.localStorage.getItem(CFG.historyKey) || '[]'); } catch (e) { return []; }
  }
  function remember(entry) {
    try {
      var all = history().filter(function (e) { return e.jobId !== entry.jobId; });
      all.unshift(entry);
      global.localStorage.setItem(CFG.historyKey, JSON.stringify(all.slice(0, CFG.historyLimit)));
    } catch (e) { /* private mode / quota — history is a convenience, never fail the run */ }
  }

  // ── dom helpers ───────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
    catch (e) { return iso || ''; }
  }

  function injectCss() {
    if (document.getElementById('rsx-css')) return;
    var s = el('style'); s.id = 'rsx-css';
    s.textContent = [
      '.rsx-mask{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:10000;opacity:0;transition:opacity .25s}',
      '.rsx-mask.on{opacity:1}',
      '.rsx-drawer{position:fixed;top:0;right:0;height:100%;width:420px;max-width:100vw;background:#fff;z-index:10001;',
      'box-shadow:-8px 0 28px rgba(15,23,42,.18);transform:translateX(100%);transition:transform .3s;display:flex;flex-direction:column;',
      'font-family:inherit;color:#1e293b}',
      '.rsx-drawer.on{transform:translateX(0)}',
      '.rsx-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px;border-bottom:1px solid #e6e9ef}',
      '.rsx-head h3{margin:0;font-size:16px;font-weight:600}',
      '.rsx-sub{font-size:12.5px;color:#64748b;margin-top:3px;line-height:1.5}',
      '.rsx-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#94a3b8;margin-top:2px}',
      '.rsx-x{margin-left:auto;border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:#94a3b8;padding:0 2px}',
      '.rsx-x:hover{color:#334155}',
      '.rsx-body{flex:1;overflow:auto;padding:16px 18px}',
      '.rsx-foot{border-top:1px solid #e6e9ef;padding:14px 18px;background:#fbfcfd}',
      '.rsx-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;font-weight:600;margin:0 0 8px}',
      '.rsx-field{margin-bottom:14px}',
      '.rsx-field>label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#424b5b;margin-bottom:5px}',
      '.rsx-req{color:#dc2626}',
      '.rsx-dep{font-size:9.5px;background:#eff6ff;color:#2563eb;border-radius:20px;padding:1px 7px;font-weight:500}',
      '.rsx-type{margin-left:auto;font-weight:400;color:#94a3b8;font-size:10.5px}',
      '.rsx-input{width:100%;height:36px;border:1px solid #d6dae3;border-radius:8px;padding:0 10px;font-size:13px;',
      'font-family:inherit;color:#1e293b;background:#fff;outline:none;box-sizing:border-box}',
      '.rsx-input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}',
      '.rsx-input:disabled{background:#f1f5f9;color:#94a3b8}',
      '.rsx-fmts{display:flex;gap:7px;flex-wrap:wrap}',
      '.rsx-fmt{height:32px;padding:0 14px;border:1px solid #d6dae3;border-radius:8px;background:#fff;font-size:12.5px;',
      'font-family:inherit;cursor:pointer;color:#424b5b}',
      '.rsx-fmt.on{border-color:#2563eb;background:#eff6ff;color:#2563eb;font-weight:600}',
      '.rsx-run{width:100%;height:42px;border:0;border-radius:9px;background:#1d4ed8;color:#fff;font-size:14px;',
      'font-weight:600;font-family:inherit;cursor:pointer}',
      '.rsx-run:hover{background:#1e40af}',
      '.rsx-run:disabled{background:#94a3b8;cursor:default}',
      '.rsx-note{font-size:12px;color:#64748b;line-height:1.6;margin-top:10px}',
      '.rsx-job{margin-top:12px;border:1px solid #e6e9ef;border-radius:9px;padding:10px 12px;background:#fff}',
      '.rsx-jobid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:#1d4ed8}',
      '.rsx-bar{height:5px;border-radius:4px;background:#e2e8f0;overflow:hidden;margin-top:8px}',
      '.rsx-bar>i{display:block;height:100%;background:#2563eb;width:0;transition:width .4s}',
      '.rsx-state{font-size:11.5px;color:#64748b;margin-top:6px}',
      '.rsx-err{color:#dc2626}',
      '.rsx-ok{color:#15803d}',
      '.rsx-hist{margin-top:12px}',
      '.rsx-hrow{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed #e6e9ef;font-size:11.5px}',
      '.rsx-hrow .j{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;color:#334155}',
      '.rsx-hrow .t{color:#94a3b8;margin-left:auto}',
      '.rsx-dl{border:1px solid #d6dae3;background:#fff;border-radius:6px;font-size:11px;padding:2px 8px;cursor:pointer;color:#334155}',
      '.rsx-dl:hover{border-color:#2563eb;color:#2563eb}',
      '@media(max-width:520px){.rsx-drawer{width:100vw}}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── parameter field ───────────────────────────────────────────────────────────
  /**
   * One parameter input. Mirrors Report Studio's own Run Task field semantics so a report
   * behaves identically here and there: query/sql-sourced params (and anything with options,
   * enum or boolean) render as a select; a param with dependsOn re-loads whenever its parent
   * changes and stays disabled until the parent has a value.
   */
  function ParamField(def, state, onChange) {
    var isSelect = def.sourceType === 'query' || def.sourceType === 'sql'
      || (def.staticOptions && def.staticOptions.length > 0)
      || def.type === 'boolean' || def.type === 'enum';

    var wrap = el('div', 'rsx-field');
    var label = el('label');
    label.appendChild(document.createTextNode(def.label || def.name));
    if (def.requiredOverride != null ? def.requiredOverride : def.required) label.appendChild(el('span', 'rsx-req', '*'));
    if (def.dependsOn) label.appendChild(el('span', 'rsx-dep', '← ' + def.dependsOn));
    label.appendChild(el('span', 'rsx-type', def.type || ''));
    wrap.appendChild(label);

    var input = el(isSelect ? 'select' : 'input', 'rsx-input');
    if (!isSelect) {
      input.type = (def.type === 'integer' || def.type === 'number') ? 'number' : 'text';
      input.placeholder = def.defaultValue != null ? String(def.defaultValue) : '—';
      input.value = state[def.name] != null ? state[def.name] : '';
      input.addEventListener('input', function () { onChange(def.name, input.value); });
    } else {
      input.addEventListener('change', function () { onChange(def.name, input.value); });
    }
    wrap.appendChild(input);

    function setOptions(list, placeholder) {
      clear(input);
      var ph = el('option', null, placeholder || '— Select —');
      ph.value = '';
      input.appendChild(ph);
      (list || []).forEach(function (o) {
        var opt = el('option', null, o.label != null ? o.label : o.value);
        opt.value = o.value;
        input.appendChild(opt);
      });
      var cur = state[def.name];
      input.value = (cur != null && cur !== '') ? cur : '';
      // The stored value may not exist in the freshly loaded list (parent changed) — drop it.
      if (input.value !== (cur == null ? '' : cur)) onChange(def.name, input.value);
    }

    function reload() {
      if (!isSelect) return;
      var waitingForParent = !!def.dependsOn && !state[def.dependsOn];
      if (waitingForParent) { input.disabled = true; setOptions([], 'Select ' + def.dependsOn + ' first'); return; }
      if (def.sourceType === 'static' && def.staticOptions && def.staticOptions.length) {
        input.disabled = false; setOptions(def.staticOptions); return;
      }
      input.disabled = true; setOptions([], 'Loading…');
      api.options(def.name, def.dependsOn ? state[def.dependsOn] : undefined)
        .then(function (list) { input.disabled = false; setOptions(list); })
        .catch(function () { input.disabled = false; setOptions([], 'Failed to load options'); });
    }

    reload();
    return { el: wrap, def: def, reload: reload };
  }

  // ── drawer ────────────────────────────────────────────────────────────────────
  function open(opts) {
    injectCss();
    // Accept either a single reportCode or a list of reports. A list renders a "Report"
    // picker at the top (like the app's own export drawers); picking one reloads its form.
    var reports = (opts.reports && opts.reports.length)
      ? opts.reports.slice()
      : (opts.reportCode ? [{ code: opts.reportCode, label: opts.label }] : null);
    if (!reports) throw new Error('RSExport.open: reportCode or reports[] is required');
    var current = reports[0].code;

    var state = {};                 // param name -> value
    var fields = [];
    var hiddenDefs = [];            // declared params the caller supplies itself (opts.hidden)
    var hide = {};
    (opts.hidden || []).forEach(function (n) { hide[n] = 1; });
    var fmt = opts.format || null;
    var timer = null, cancelled = false;

    var mask = el('div', 'rsx-mask');
    var drawer = el('aside', 'rsx-drawer');
    var head = el('div', 'rsx-head');
    var titles = el('div');
    titles.appendChild(el('h3', null, opts.title || 'Export report'));
    var sub = el('div', 'rsx-sub', 'Loading…');
    var code = el('div', 'rsx-code', current);
    titles.appendChild(sub); titles.appendChild(code);
    var x = el('button', 'rsx-x', '×');
    head.appendChild(titles); head.appendChild(x);

    var body = el('div', 'rsx-body');
    // "Report" picker — only when more than one report is offered.
    if (reports.length > 1) {
      var reportField = el('div', 'rsx-field');
      reportField.appendChild(el('label', null, 'Report'));
      var rsel = el('select', 'rsx-input');
      reports.forEach(function (rp) {
        var o = el('option', null, rp.label || rp.code);
        o.value = rp.code;
        rsel.appendChild(o);
      });
      rsel.value = current;
      rsel.addEventListener('change', function () {
        current = rsel.value; code.textContent = current; loadReport(current);
      });
      reportField.appendChild(rsel);
      body.appendChild(reportField);
    }
    var paramsLabel = el('div', 'rsx-label', 'Parameters');
    var paramsBox = el('div');
    var fmtField = el('div', 'rsx-field');
    body.appendChild(paramsLabel); body.appendChild(paramsBox); body.appendChild(fmtField);

    var foot = el('div', 'rsx-foot');
    var runBtn = el('button', 'rsx-run', 'Download report');
    runBtn.disabled = true;
    var jobBox = el('div', 'rsx-job'); jobBox.style.display = 'none';
    var histBox = el('div', 'rsx-hist');
    foot.appendChild(runBtn); foot.appendChild(jobBox); foot.appendChild(histBox);

    drawer.appendChild(head); drawer.appendChild(body); drawer.appendChild(foot);
    document.body.appendChild(mask); document.body.appendChild(drawer);
    requestAnimationFrame(function () { mask.classList.add('on'); drawer.classList.add('on'); });

    function close() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      mask.classList.remove('on'); drawer.classList.remove('on');
      setTimeout(function () {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
      }, 300);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    x.addEventListener('click', close);
    mask.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    function setParam(name, value) {
      state[name] = value;
      // Reset + reload anything that cascades off this param (same rule as Run Task).
      fields.forEach(function (f) { if (f.def.dependsOn === name) { delete state[f.def.name]; f.reload(); } });
    }

    loadReport(current);

    // (Re)load a report's name, parameters and formats into the drawer — on open, and again
    // whenever the Report picker changes. Resets the per-report form state each time.
    function loadReport(reportCode) {
      // Switching reports must not leave the previous run's status box showing — hide it and stop
      // any in-flight poll. It reappears only when the newly picked report is actually run.
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      jobBox.style.display = 'none'; clear(jobBox);
      state = {}; fields = []; hiddenDefs = [];
      fmt = opts.format || null;
      sub.className = 'rsx-sub'; sub.textContent = 'Loading…';
      clear(paramsBox); clear(fmtField);
      runBtn.disabled = true;
      renderHistory();
      Promise.all([api.report(reportCode), api.params(reportCode)])
        .then(function (res) {
          if (reportCode !== current) return; // a newer picker selection superseded this load
          var rpt = res[0], defs = res[1] || [];
          sub.textContent = rpt.name || rpt.code;

          defs.forEach(function (d) { if (d.defaultValue != null) state[d.name] = String(d.defaultValue); });
          for (var k in (opts.defaults || {})) state[k] = String(opts.defaults[k]);

          clear(paramsBox);
          if (!defs.length) paramsBox.appendChild(el('div', 'rsx-note', 'This report has no parameters'));
          defs.forEach(function (d) {
            // opts.hidden: the host page supplies this one (via defaults) and the user must not
            // see or edit it — e.g. a scope/role field the server re-derives from the token
            // anyway. The value still travels to /run because it lives in `state`.
            if (hide[d.name]) { hiddenDefs.push(d); return; }
            var f = ParamField(d, state, setParam);
            fields.push(f);
            paramsBox.appendChild(f.el);
          });
          if (!defs.length || defs.length === hiddenDefs.length) {
            clear(paramsBox);
            paramsBox.appendChild(el('div', 'rsx-note', 'This report has no parameters to fill in'));
          }

          var formats = (rpt.formats && rpt.formats.length) ? rpt.formats : ['PDF'];
          if (!fmt || formats.indexOf(fmt) < 0) fmt = formats[0];
          clear(fmtField);
          fmtField.appendChild(el('label', null, 'File format'));
          var fmts = el('div', 'rsx-fmts');
          formats.forEach(function (f) {
            var b = el('button', 'rsx-fmt' + (f === fmt ? ' on' : ''), f);
            b.addEventListener('click', function () {
              fmt = f;
              Array.prototype.forEach.call(fmts.children, function (c) { c.className = 'rsx-fmt' + (c.textContent === f ? ' on' : ''); });
            });
            fmts.appendChild(b);
          });
          fmtField.appendChild(fmts);
          runBtn.disabled = false;
        })
        .catch(function (e) {
          if (reportCode !== current) return;
          sub.className = 'rsx-sub rsx-err';
          sub.textContent = e.message || 'Failed to load report';
        });
    }

    runBtn.addEventListener('click', function () {
      // Hidden params are validated too — a required one the host forgot to pass would otherwise
      // reach the backend as empty and fail there instead of here.
      var missing = fields.map(function (f) { return f.def; }).concat(hiddenDefs)
        .filter(function (d) {
          var need = d.requiredOverride != null ? d.requiredOverride : d.required;
          return need && !state[d.name];
        });
      if (missing.length) {
        showJob({ err: 'Please fill in: ' + missing.map(function (d) { return d.label || d.name; }).join(', ') });
        return;
      }
      start();
    });

    function start() {
      cancelled = false;
      runBtn.disabled = true;
      showJob({ state: 'queued' });
      api.run(current, { format: fmt, params: state, priority: 'normal' })
        .then(function (r) {
          var jobId = r.jobId;
          remember({ jobId: jobId, code: current, name: sub.textContent, fmt: fmt, at: new Date().toISOString(), state: 'queued' });
          renderHistory();
          showJob({ jobId: jobId, state: 'queued' });
          poll(jobId, Date.now());
        })
        .catch(function (e) { runBtn.disabled = false; showJob({ err: e.message }); });
    }

    function poll(jobId, startedAt) {
      if (cancelled) return;
      timer = setTimeout(function () {
        api.job(jobId).then(function (j) {
          if (cancelled) return;
          showJob({ jobId: jobId, state: j.state, progress: j.progress, stage: j.stage });
          if (j.state === 'done') {
            remember({ jobId: jobId, code: current, name: sub.textContent, fmt: j.fmt || fmt, at: new Date().toISOString(), state: 'done' });
            renderHistory();
            runBtn.disabled = false;
            grab(jobId).then(function () { if (opts.onDone) opts.onDone(jobId); });
            return;
          }
          if (j.state === 'error') {
            runBtn.disabled = false;
            showJob({ jobId: jobId, err: j.errorMessage || 'Render failed' });
            if (opts.onError) opts.onError(j);
            return;
          }
          if (Date.now() - startedAt > CFG.pollTimeoutMs) {
            runBtn.disabled = false;
            showJob({ jobId: jobId, err: 'Timed out — check the result later via the Job number below' });
            return;
          }
          poll(jobId, startedAt);
        }).catch(function (e) {
          runBtn.disabled = false;
          showJob({ jobId: jobId, err: e.message });
        });
      }, timer === null ? CFG.firstPollMs : CFG.pollMs);
    }

    function showJob(s) {
      jobBox.style.display = '';
      clear(jobBox);
      if (s.jobId) {
        var row = el('div');
        row.appendChild(el('span', null, 'Job '));
        row.appendChild(el('span', 'rsx-jobid', s.jobId));
        jobBox.appendChild(row);
      }
      if (s.err) { jobBox.appendChild(el('div', 'rsx-state rsx-err', s.err)); return; }
      var bar = el('div', 'rsx-bar'); var i = el('i');
      i.style.width = (s.state === 'done' ? 100 : (s.progress || 5)) + '%';
      bar.appendChild(i); jobBox.appendChild(bar);
      var txt = s.state === 'done' ? 'Done — downloading file'
        : s.state === 'queued' ? 'Queued…'
        : s.state === 'running' ? ('Generating file' + (s.stage ? ' · ' + s.stage : '') + '…')
        : 'Sending request…';
      jobBox.appendChild(el('div', 'rsx-state' + (s.state === 'done' ? ' rsx-ok' : ''), txt));
      if (s.state !== 'done' && s.state !== 'error') {
        jobBox.appendChild(el('div', 'rsx-state', 'Large files can take a while. You can close this window and download later via the Job number below'));
      }
    }

    function renderHistory() {
      clear(histBox);
      var mine = history().filter(function (h) { return h.code === current; });
      if (!mine.length) return;
      histBox.appendChild(el('div', 'rsx-label', 'Recent jobs'));
      mine.forEach(function (h) {
        var row = el('div', 'rsx-hrow');
        row.appendChild(el('span', 'j', h.jobId));
        row.appendChild(el('span', null, h.fmt || ''));
        row.appendChild(el('span', 't', fmtTime(h.at)));
        var b = el('button', 'rsx-dl', 'Download');
        b.addEventListener('click', function () { b.disabled = true; grab(h.jobId).finally(function () { b.disabled = false; }); });
        row.appendChild(b);
        histBox.appendChild(row);
      });
    }
  }

  /** Pull a finished job's artifact and save it. 404 = not ready / no file (per the external API). */
  function grab(jobId) {
    return api.download(jobId).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw httpError(r.status, t); });
      var name = filenameOf(r.headers.get('content-disposition')) || (jobId + '.bin');
      return r.blob().then(function (blob) { saveBlob(blob, name); });
    }).catch(function (e) {
      alertish(e.status === 404 ? 'No file for this Job yet (it may still be running)' : (e.message || 'Download failed'));
      throw e;
    });
  }

  function filenameOf(cd) {
    if (!cd) return null;
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* fall through */ } }
    m = /filename="?([^";]+)"?/i.exec(cd);
    return m ? m[1] : null;
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** Use the host app's SweetAlert if it exposes one; otherwise a plain alert. */
  function alertish(msg) {
    if (typeof global.alertModal === 'function') { try { global.alertModal('error', msg); return; } catch (e) { /* fall back */ } }
    if (global.Swal && global.Swal.fire) { try { global.Swal.fire({ icon: 'error', text: msg }); return; } catch (e) { /* fall back */ } }
    global.alert(msg);
  }

  // ── public api ────────────────────────────────────────────────────────────────
  /**
   * Render an export button into `target`. Returns null when the caller lacks permission
   * (nothing is added to the DOM), so a template can call this unconditionally.
   */
  function mount(opts) {
    if (!opts || (!opts.reportCode && !(opts.reports && opts.reports.length)))
      throw new Error('RSExport.mount: reportCode or reports[] is required');
    if (!allowed(opts.permission)) return null;
    var host = typeof opts.target === 'string' ? document.querySelector(opts.target) : opts.target;
    if (!host) return null;

    var btn = el('button', opts.className || 'rsx-trigger', opts.label || 'Export report');
    btn.type = 'button';
    if (!opts.className) {
      // Only style it when the host didn't hand us its own class — otherwise inherit their look.
      injectCss();
      btn.style.cssText = 'height:38px;padding:0 16px;border:1px solid #d6dae3;border-radius:8px;background:#fff;'
        + 'font-family:inherit;font-size:13px;cursor:pointer;color:#1e293b';
    }
    btn.addEventListener('click', function () { open(opts); });
    host.appendChild(btn);
    return { el: btn, open: function () { open(opts); }, destroy: function () { if (btn.parentNode) btn.parentNode.removeChild(btn); } };
  }

  global.RSExport = {
    configure: configure,
    mount: mount,
    open: open,
    can: allowed,
    history: history,
    download: grab,
    version: '1.0.0'
  };
})(window);
