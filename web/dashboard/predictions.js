(function () {
  'use strict';

  const state = { contexts: [], loading: false };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const number = (value, digits = 1) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toLocaleString('it-IT', { maximumFractionDigits: digits }) : 'N/D';
  };
  const percent = (value) => Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : 'N/D';
  const minutes = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'Non stimato';
    if (parsed < 60) return `${Math.round(parsed)} min`;
    if (parsed < 1440) return `${number(parsed / 60, 1)} h`;
    return `${number(parsed / 1440, 1)} g`;
  };
  const timestamp = (value) => {
    if (!value) return 'Non disponibile';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Non disponibile' : date.toLocaleString('it-IT', {
      dateStyle: 'short', timeStyle: 'short'
    });
  };
  const label = (value) => String(value || 'unknown').replaceAll('_', ' ');
  const apiRoot = () => String(window.RAYAT_RUNTIME_CONFIG?.apiBaseUrl || '/api').replace(/\/+$/, '');
  const token = () => localStorage.getItem('rayat_token') || sessionStorage.getItem('rayat_token')
    || sessionStorage.getItem('rayat_admin_token') || '';
  const storedUser = () => {
    for (const key of ['rayat_user', 'rayat_admin_user']) {
      for (const storage of [localStorage, sessionStorage]) {
        try { const value = storage.getItem(key); if (value) return JSON.parse(value); } catch (_error) { /* noop */ }
      }
    }
    return null;
  };
  async function api(path) {
    const auth = token();
    if (!auth) throw new Error('Sessione non disponibile. Accedi a Rayat e riprova.');
    const response = await fetch(`${apiRoot()}${path}`, {
      headers: { Authorization: `Bearer ${auth}` }, credentials: 'same-origin'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Richiesta non riuscita');
    return body;
  }
  function empty(text) { return `<p class="empty">${esc(text)}</p>`; }
  function confidence(value) {
    const width = Math.max(0, Math.min(100, Number(value) * 100 || 0));
    return `<span class="confidence"><span class="confidence-track"><i style="width:${width}%"></i></span>${percent(value)}</span>`;
  }
  function pill(value) { return `<span class="pill" data-tone="${esc(value)}">${esc(label(value))}</span>`; }

  function renderMetrics(rows) {
    $('metric-count').textContent = rows.length;
    if (!rows.length) return empty('Forecast metrici non ancora disponibili per questo contesto.');
    return `<table><thead><tr><th>Metrica</th><th>Orizzonte</th><th>Attuale</th><th>Previsto</th><th>Intervallo</th><th>Confidenza</th><th>Calcolato</th></tr></thead><tbody>${rows.map((row) =>
      `<tr><td data-label="Metrica"><strong>${esc(row.metric)}</strong></td><td data-label="Orizzonte">${minutes(row.horizon_minutes)}</td><td data-label="Attuale">${number(row.current_value, 2)}</td><td data-label="Previsto">${number(row.forecast_value, 2)}</td><td data-label="Intervallo">${number(row.forecast_low, 2)} – ${number(row.forecast_high, 2)}</td><td data-label="Confidenza">${confidence(row.confidence)}</td><td data-label="Calcolato">${timestamp(row.generated_at)}</td></tr>`
    ).join('')}</tbody></table>`;
  }
  function renderBreach(rows) {
    if (!rows.length) return empty('Nessun Breach ETA disponibile.');
    return rows.slice(0, 8).map((row) => `<div class="signal-row"><div class="signal-head"><strong>${esc(row.metric)}</strong>${pill(row.severity)}</div><div class="signal-meta"><span>${esc(label(row.breach_direction))}</span><span>ETA ${minutes(row.eta_minutes)}</span><span>Confidenza ${percent(row.eta_confidence)}</span><span>${timestamp(row.generated_at)}</span></div></div>`).join('');
  }
  function renderStress(rows) {
    if (!rows.length) return empty('Stress ETA non ancora disponibile.');
    return rows.map((row) => `<div class="signal-row"><div class="signal-head"><strong>${esc(label(row.stress_type))}</strong>${pill(row.severity)}</div><div class="signal-meta"><span>Probabilità ${percent(row.stress_probability)}</span><span>ETA ${minutes(row.eta_minutes)}</span><span>${esc(label(row.status))}</span><span>${timestamp(row.generated_at)}</span></div></div>`).join('');
  }
  function renderRisk(rows) {
    if (!rows.length) return empty('Risk Forecast non ancora disponibile.');
    return rows.map((row) => `<div class="risk-card"><span>${minutes(row.forecast_horizon_minutes)}</span><strong>${number(row.overall_risk_score, 0)}</strong>${pill(row.overall_risk_band)}<small>Confidenza ${percent(row.confidence)}</small></div>`).join('');
  }
  function renderRecovery(row) {
    if (!row) return empty('Recovery Forecast non ancora disponibile.');
    return `<div class="recovery-hero"><div><div class="recovery-time">${minutes(row.estimated_recovery_minutes)} <small>tempo atteso</small></div><div class="signal-meta">${pill(row.estimated_recovery_band)}<span>Calcolato ${timestamp(row.generated_at)}</span></div></div><div class="recovery-stats"><strong>Probabilità ${percent(row.recovery_probability)}</strong><span>Qualità attesa ${percent(row.expected_recovery_quality)}</span><span>Confidenza ${percent(row.confidence)}</span></div></div>`;
  }
  function renderWarnings(rows) {
    $('warning-count').textContent = rows.length;
    if (!rows.length) return empty('Nessun warning attivo per questo contesto.');
    return rows.map((row) => `<div class="warning-card" data-level="${esc(row.warning_level)}"><div class="signal-head"><h3>${esc(row.title)}</h3>${pill(row.warning_level)}</div><div class="signal-meta"><span>ETA ${minutes(row.eta_minutes)}</span><span>Probabilità ${percent(row.probability)}</span><span>${timestamp(row.generated_at)}</span></div><p>${esc(row.summary)}</p><p class="recommended">${esc(row.recommended_action)}</p></div>`).join('');
  }
  function render(data) {
    $('latest-time').textContent = timestamp(data.latest_prediction_at);
    $('metric-content').innerHTML = renderMetrics(data.metric_forecasts || []);
    $('breach-content').innerHTML = renderBreach(data.breach_eta || []);
    $('stress-content').innerHTML = renderStress(data.stress_eta || []);
    $('risk-content').innerHTML = renderRisk(data.risk_forecasts || []);
    $('recovery-content').innerHTML = renderRecovery(data.recovery_forecast);
    $('warning-content').innerHTML = renderWarnings(data.early_warnings || []);
    $('page-message').classList.add('is-hidden');
    $('dashboard').classList.remove('is-hidden');
  }
  function showMessage(message, isError = false) {
    $('dashboard').classList.add('is-hidden');
    $('page-message').textContent = message;
    $('page-message').className = `page-message${isError ? ' error' : ''}`;
  }
  async function loadContexts() {
    const owner = $('owner-id').value.trim();
    const path = `/predictions/contexts${owner ? `?owner_user_id=${encodeURIComponent(owner)}` : ''}`;
    const data = await api(path);
    state.contexts = data.contexts || [];
    const select = $('context-select');
    select.innerHTML = state.contexts.length
      ? state.contexts.map((item) => `<option value="${item.device_id}:${item.context_id}">${esc(item.device_name)} · ${esc(item.context_name)}${item.crop_label ? ` · ${esc(item.crop_label)}` : ''}</option>`).join('')
      : '<option value="">Nessun contesto production disponibile</option>';
    select.disabled = !state.contexts.length;
    const params = new URLSearchParams(location.search);
    const requested = `${params.get('device_id') || ''}:${params.get('context_id') || ''}`;
    if (state.contexts.some((item) => `${item.device_id}:${item.context_id}` === requested)) select.value = requested;
    if (state.contexts.length) await loadOverview(); else showMessage('Nessun contesto production disponibile per il tuo account.');
  }
  async function loadOverview() {
    const value = $('context-select').value;
    if (!value || state.loading) return;
    const [deviceId, contextId] = value.split(':');
    state.loading = true; $('refresh-button').disabled = true;
    showMessage('Caricamento delle previsioni...');
    try {
      const data = await api(`/predictions/overview?device_id=${encodeURIComponent(deviceId)}&context_id=${encodeURIComponent(contextId)}`);
      history.replaceState({}, '', `/dashboard/predictions.html?device_id=${encodeURIComponent(deviceId)}&context_id=${encodeURIComponent(contextId)}`);
      render(data);
    } catch (error) { showMessage(error.message || 'Errore nel caricamento delle previsioni.', true); }
    finally { state.loading = false; $('refresh-button').disabled = false; }
  }
  async function init() {
    const user = storedUser();
    if (user && user.role === 'super_admin') $('owner-field').classList.remove('is-hidden');
    $('refresh-button').addEventListener('click', loadOverview);
    $('context-select').addEventListener('change', loadOverview);
    $('owner-id').addEventListener('change', () => loadContexts().catch((error) => showMessage(error.message, true)));
    try { await loadContexts(); } catch (error) { showMessage(error.message || 'Impossibile caricare i contesti.', true); }
  }
  window.RayatPredictionUI = { renderMetrics, renderBreach, renderStress, renderRisk, renderRecovery, renderWarnings };
  init();
})();
