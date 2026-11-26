/* Private Consilium administrator dashboard. All applicant data comes from authenticated APIs. */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const state = {
    limit: 50,
    offset: 0,
    total: 0,
    currentId: null,
    currentApplication: null,
    rows: []
  };

  const loginView = byId('login-view');
  const dashboardView = byId('dashboard-view');
  const loginForm = byId('login-form');
  const loginMessage = byId('login-message');
  const loginSubmit = byId('login-submit');
  const logoutButton = byId('logout-button');
  const listElement = byId('application-list');
  const listMessage = byId('list-message');
  const statusFilter = byId('status-filter');
  const searchInput = byId('search-input');
  const detailEmpty = byId('detail-empty');
  const detailContent = byId('detail-content');
  const detailMessage = byId('detail-message');

  async function api(path, options) {
    const response = await fetch(path, Object.assign({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }, options || {}));
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error('The server returned an unreadable response.');
    }
    if (!response.ok || !data || data.ok !== true) {
      if (response.status === 401) showLogin('Your administrator session has expired. Please sign in again.');
      throw new Error((data && data.message) || `Request failed (${response.status}).`);
    }
    return data;
  }

  function setMessage(element, message) {
    element.textContent = message || '';
  }

  function toast(message) {
    const element = byId('global-message');
    element.textContent = message;
    element.classList.add('visible');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => { element.classList.remove('visible'); }, 4500);
  }

  function showLogin(message) {
    loginView.hidden = false;
    dashboardView.hidden = true;
    logoutButton.hidden = true;
    setMessage(loginMessage, message || '');
    byId('admin-password').value = '';
  }

  function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    logoutButton.hidden = false;
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Casablanca'
    }).format(date) + ' (Casablanca)';
  }

  function formatAppointment(date, start, end, timezone) {
    if (!date || !start) return 'Not requested';
    return `${date} · ${start}${end ? `–${end}` : ''} · ${timezone || 'Africa/Casablanca'}`;
  }

  function addField(container, label, value) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    if (Array.isArray(value)) description.textContent = value.length ? value.join(', ') : '—';
    else if (value === null || value === undefined || value === '') description.textContent = '—';
    else description.textContent = String(value);
    wrapper.append(term, description);
    container.appendChild(wrapper);
  }

  function statusLabel(status) {
    return String(status || 'UNKNOWN').replaceAll('_', ' ');
  }

  function renderCounts(counts) {
    byId('count-pending').textContent = String((counts && counts.PENDING) || 0);
    byId('count-accepted').textContent = String((counts && counts.ACCEPTED) || 0);
    byId('count-declined').textContent = String((counts && counts.DECLINED) || 0);
  }

  function renderList() {
    listElement.replaceChildren();
    if (!state.rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = 'No applications match this filter.';
      listElement.appendChild(empty);
    }
    for (const application of state.rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'application-item';
      button.setAttribute('aria-current', application.id === state.currentId ? 'true' : 'false');
      const ref = document.createElement('span');
      ref.className = 'ref';
      ref.textContent = application.reference;
      const name = document.createElement('strong');
      name.textContent = application.full_name;
      const status = document.createElement('span');
      status.className = 'meta';
      status.textContent = `${statusLabel(application.status)} · ${application.appointment_date} ${application.appointment_start} · ${application.email}`;
      button.append(ref, name, status);
      button.addEventListener('click', () => loadDetail(application.id));
      listElement.appendChild(button);
    }
    byId('page-label').textContent = `Page ${Math.floor(state.offset / state.limit) + 1} · ${state.total} applications`;
    byId('previous-page').disabled = state.offset <= 0;
    byId('next-page').disabled = state.offset + state.limit >= state.total;
  }

  async function loadApplications() {
    setMessage(listMessage, 'Loading applications…');
    const params = new URLSearchParams({
      limit: String(state.limit),
      offset: String(state.offset),
      status: statusFilter.value,
      q: searchInput.value.trim()
    });
    try {
      const data = await api(`/api/admin/applications?${params.toString()}`);
      state.rows = Array.isArray(data.applications) ? data.applications : [];
      state.total = Number(data.total || 0);
      renderCounts(data.counts || {});
      renderList();
      setMessage(listMessage, '');
      if (state.currentId && !state.rows.some((row) => row.id === state.currentId)) {
        state.currentId = null;
        state.currentApplication = null;
        detailContent.hidden = true;
        detailEmpty.hidden = false;
      }
    } catch (error) {
      state.rows = [];
      renderList();
      setMessage(listMessage, error.message);
    }
  }

  function renderNotifications(notifications) {
    const container = byId('notification-list');
    container.replaceChildren();
    const rows = Array.isArray(notifications) ? notifications : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = 'No email notification records.';
      container.appendChild(empty);
      return;
    }
    for (const notification of rows) {
      const item = document.createElement('div');
      item.className = 'notification-item';
      const left = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = statusLabel(notification.event_type);
      const recipient = document.createElement('small');
      recipient.textContent = `${notification.recipient || 'Unknown recipient'}${notification.last_error ? ` · ${notification.last_error}` : ''}`;
      left.append(title, document.createElement('br'), recipient);
      const right = document.createElement('span');
      right.className = 'status-pill';
      right.textContent = statusLabel(notification.status);
      item.append(left, right);
      container.appendChild(item);
    }
  }

  function renderDetail(application) {
    state.currentApplication = application;
    state.currentId = application.id;
    detailEmpty.hidden = true;
    detailContent.hidden = false;
    byId('detail-reference').textContent = application.reference || '';
    byId('detail-name').textContent = application.full_name || 'Applicant';
    byId('detail-submitted').textContent = `Submitted ${formatDateTime(application.created_at)} · Updated ${formatDateTime(application.updated_at)}`;
    byId('detail-status').textContent = statusLabel(application.status);
    byId('applicant-fields').replaceChildren();
    byId('appointment-fields').replaceChildren();
    byId('answer-fields').replaceChildren();

    addField(byId('applicant-fields'), 'Email address', application.email);
    addField(byId('applicant-fields'), 'Phone number', application.phone);
    addField(byId('applicant-fields'), 'Country', application.country);
    addField(byId('applicant-fields'), 'City', application.city);
    addField(byId('applicant-fields'), 'Website / LinkedIn / reference page', application.reference_url);
    addField(byId('applicant-fields'), 'Applicant type', application.applicant_type);
    addField(byId('applicant-fields'), 'Industry or market', application.industry_market);

    addField(byId('appointment-fields'), 'Requested appointment', formatAppointment(
      application.appointment_date, application.appointment_start, application.appointment_end, application.appointment_timezone
    ));
    addField(byId('appointment-fields'), 'Applicant timezone', application.applicant_timezone);
    addField(byId('appointment-fields'), 'Appointment status', application.status);
    addField(byId('appointment-fields'), 'Application reference', application.reference);
    if (application.meet_link) addField(byId('appointment-fields'), 'Google Meet link', application.meet_link);

    const answers = application.answers && typeof application.answers === 'object' ? application.answers : {};
    const known = new Set(['name', 'email', 'phone', 'country', 'city', 'reference_url', 'applicant_type', 'industry_market', 'objectives', 'working_toward', 'additional_context', 'appointment_date', 'appointment_time', 'applicant_timezone', 'ability_to_accept_change', 'submission_nonce', 'website']);
    addField(byId('answer-fields'), 'Objectives', application.objectives || []);
    addField(byId('answer-fields'), 'What they are working towards / how Consilium could help', application.working_toward);
    addField(byId('answer-fields'), 'Additional context', application.additional_context);
    addField(byId('answer-fields'), 'Ability to accept change (1–10)', application.ability_to_accept_change);
    for (const [key, value] of Object.entries(answers)) {
      if (!known.has(key)) addField(byId('answer-fields'), key, value);
    }

    byId('admin-notes').value = application.admin_notes || '';
    byId('raw-answers').textContent = JSON.stringify(answers, null, 2);
    renderNotifications(application.notifications);
    const isPending = application.status === 'PENDING';
    byId('accept-button').disabled = !isPending;
    byId('decline-button').disabled = !isPending;
    byId('retry-email-button').disabled = !(application.notifications || []).some((n) => n.status === 'FAILED');
    setMessage(detailMessage, '');
    renderList();
  }

  async function loadDetail(id) {
    setMessage(detailMessage, 'Loading application…');
    try {
      const data = await api(`/api/admin/applications/${encodeURIComponent(id)}`);
      renderDetail(data.application);
    } catch (error) {
      setMessage(detailMessage, error.message);
    }
  }

  async function changeStatus(action) {
    const application = state.currentApplication;
    if (!application || application.status !== 'PENDING') return;
    const actionText = action === 'accept' ? 'accept this appointment request' : 'decline this application and release its requested slot';
    if (!window.confirm(`Are you sure you want to ${actionText}?`)) return;
    byId('accept-button').disabled = true;
    byId('decline-button').disabled = true;
    setMessage(detailMessage, 'Saving application status…');
    try {
      const data = await api(`/api/admin/applications/${encodeURIComponent(application.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({})
      });
      toast(action === 'accept' ? 'Application accepted.' : 'Application declined; its appointment slot is released.');
      await loadApplications();
      await loadDetail(application.id);
    } catch (error) {
      setMessage(detailMessage, error.message);
      byId('accept-button').disabled = false;
      byId('decline-button').disabled = false;
    }
  }

  async function saveNotes() {
    if (!state.currentApplication) return;
    setMessage(detailMessage, 'Saving notes…');
    try {
      await api(`/api/admin/applications/${encodeURIComponent(state.currentApplication.id)}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ notes: byId('admin-notes').value })
      });
      toast('Internal notes saved.');
      await loadDetail(state.currentApplication.id);
    } catch (error) {
      setMessage(detailMessage, error.message);
    }
  }

  async function retryEmails() {
    if (!state.currentApplication) return;
    setMessage(detailMessage, 'Retrying failed email notifications…');
    try {
      const data = await api(`/api/admin/applications/${encodeURIComponent(state.currentApplication.id)}/notifications/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({})
      });
      toast(`Email retry finished. ${data.retried || 0} notification(s) retried.`);
      await loadDetail(state.currentApplication.id);
    } catch (error) {
      setMessage(detailMessage, error.message);
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage(loginMessage, 'Signing in…');
    loginSubmit.disabled = true;
    try {
      await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: byId('admin-password').value })
      });
      showDashboard();
      state.offset = 0;
      await loadApplications();
    } catch (error) {
      setMessage(loginMessage, error.message);
    } finally {
      loginSubmit.disabled = false;
    }
  });

  logoutButton.addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({})
      });
    } catch (_error) {
      // Always return to the login screen; the cookie is cleared by the server where possible.
    }
    state.currentId = null;
    state.currentApplication = null;
    showLogin('You have been logged out.');
  });

  byId('search-button').addEventListener('click', () => { state.offset = 0; loadApplications(); });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); state.offset = 0; loadApplications(); }
  });
  statusFilter.addEventListener('change', () => { state.offset = 0; loadApplications(); });
  byId('previous-page').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadApplications();
  });
  byId('next-page').addEventListener('click', () => {
    state.offset += state.limit;
    loadApplications();
  });
  byId('accept-button').addEventListener('click', () => changeStatus('accept'));
  byId('decline-button').addEventListener('click', () => changeStatus('decline'));
  byId('save-notes-button').addEventListener('click', saveNotes);
  byId('retry-email-button').addEventListener('click', retryEmails);

  (async function initialise() {
    try {
      await api('/api/admin/me');
      showDashboard();
      await loadApplications();
    } catch (_error) {
      showLogin('');
    }
  })();
})();
