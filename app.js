const SUPABASE_URL = 'https://fkmcttbnskuxwhsvzdmu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrbWN0dGJuc2t1eHdoc3Z6ZG11Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjI5NjkwNSwiZXhwIjoyMDk3ODcyOTA1fQ.2vc3c7xK4L8IyD5-ivpYE_RSYtbRpGEkSHrhXwpFN_k';
const SESSION_KEY = 'robotics_supabase_direct_session_v1';
const MISSION_AREA_BY_NAME = window.MISSION_AREA_BY_NAME || {};
const SCHEDULE_BY_BADGE = window.SCHEDULE_BY_BADGE || {};

const app = document.getElementById('app');
let ticker = null;
let refreshLoop = null;

const state = {
  user: null,
  users: [],
  levels: [],
  tasks: [],
  criteria: [],
  kids: [],
  taskRuns: [],
  scoreDetails: [],
  auditLogs: []
};

const ui = {
  page: 'dashboard',
  selectedKidId: null,
  leaderboardLevel: 'all',
  filters: { search: '', level: 'all', status: 'all' },
  scoringDraft: {},
  selectedTaskByKid: {},
  selectedResetTaskByKid: {},
  expandedLevels: {},
  loading: false,
  error: '',
  lastBootstrapAt: 0
};

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('fr-FR');
}
function fmtSeconds(total) {
  const sec = Math.max(0, Math.floor(total || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function fmtClockMinutes(offsetMinutes) {
  if (offsetMinutes === null || offsetMinutes === undefined || offsetMinutes === '') return '—';
  const base = new Date(2000, 0, 1, 10, 15 + Number(offsetMinutes), 0, 0);
  return base.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtClockRange(start, end) {
  return `${fmtClockMinutes(start)} - ${fmtClockMinutes(end)}`;
}
function parseDurationInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(':').map(v => Number(v));
  if (parts.some(v => Number.isNaN(v))) throw new Error('Invalid duration format. Use seconds or HH:MM:SS');
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  throw new Error('Invalid duration format. Use seconds or HH:MM:SS');
}
function nowIso() {
  return new Date().toISOString();
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSession(user) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {}
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

async function sb(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || raw || 'Supabase request failed');
  }
  return data;
}
function select(table, query = '?select=*') {
  return sb(`/rest/v1/${table}${query}`);
}
function insert(table, rows, prefer = 'return=representation') {
  return sb(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: prefer },
    body: rows
  });
}
function patchRow(table, query, payload) {
  return sb(`/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: payload
  });
}
function deleteRow(table, query) {
  return sb(`/rest/v1/${table}${query}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
}
async function rpc(name, payload) {
  return sb(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: payload
  });
}

function getLevel(levelId) { return state.levels.find(level => level.id === levelId); }
function getModerators() { return state.users.filter(user => user.role === 'moderator' && user.active); }
function getTasksByLevel(levelId) { return state.tasks.filter(task => task.level_id === levelId && task.is_active !== false).sort((a, b) => a.task_order - b.task_order); }
function getCriteriaByTask(taskId) { return state.criteria.filter(criterion => criterion.task_id === taskId).sort((a, b) => a.display_order - b.display_order); }
function getKid(kidId) { return state.kids.find(kid => kid.id === kidId); }
function getRunsByKid(kidId) { return state.taskRuns.filter(run => run.kid_id === kidId); }
function getFinishedRunsByKid(kidId) { return getRunsByKid(kidId).filter(run => run.status === 'finished').sort((a, b) => new Date(a.started_at) - new Date(b.started_at)); }
function getActiveRun(kidId) { return state.taskRuns.find(run => run.kid_id === kidId && run.status === 'in_progress'); }
function getLatestAuditPayload(actionType, entityType, entityId) {
  const log = state.auditLogs.find(item => item.action_type === actionType && item.entity_type === entityType && String(item.entity_id || '') === String(entityId || ''));
  return log?.payload_json || null;
}
function getLevelMeta(levelId) {
  return getLatestAuditPayload('set_level_meta', 'level', levelId) || {};
}
function getLevelCoName(levelId) {
  return getLevelMeta(levelId).co_name || '';
}
function getTaskAssignment(taskId) {
  return getLatestAuditPayload('assign_task_moderator', 'task', taskId) || {};
}
function getTaskModeratorId(taskId) {
  return getTaskAssignment(taskId).moderator_id || null;
}
function getTaskModerator(taskId) {
  const moderatorId = getTaskModeratorId(taskId);
  return state.users.find(user => user.id === moderatorId) || null;
}

function normalizeMissionName(name = '') {
  const normalized = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = {
    legostructuredobjects: 'lego',
    legostructuredobject: 'lego'
  };
  return aliases[normalized] || normalized;
}
function getTaskArea(task) {
  return task ? (MISSION_AREA_BY_NAME[normalizeMissionName(task.name)] || 'Unassigned station') : 'Unassigned station';
}
function getScheduledEntriesForKid(kid) {
  if (!kid) return [];
  const rawEntries = SCHEDULE_BY_BADGE[String(kid.badge_number || '')] || [];
  const levelTasks = getTasksByLevel(kid.level_id);
  return rawEntries.map(entry => {
    const task = levelTasks.find(item => normalizeMissionName(item.name) === normalizeMissionName(entry.mission));
    return task ? { ...entry, task_id: task.id, task_name: task.name, area: entry.area || getTaskArea(task) } : null;
  }).filter(Boolean).sort((a, b) => Number(a.start) - Number(b.start));
}
function getScheduleEntryByTaskId(kid, taskId) {
  return getScheduledEntriesForKid(kid).find(entry => entry.task_id === taskId) || null;
}
function getKidComputedTotals(kidId) {
  const finishedRuns = getFinishedRunsByKid(kidId);
  const totalTimeSeconds = finishedRuns.reduce((sum, run) => sum + Number(run.duration_seconds || 0), 0);
  const averageScore = finishedRuns.length ? finishedRuns.reduce((sum, run) => sum + Number(run.task_score || 0), 0) / finishedRuns.length : 0;
  return { totalTimeSeconds, averageScore, finishedCount: finishedRuns.length };
}
function getLatestTaskScoreForKid(kidId, taskId) {
  const runs = getRunsByKid(kidId)
    .filter(run => run.task_id === taskId && run.status === 'finished')
    .sort((a, b) => new Date(b.ended_at || b.started_at || 0) - new Date(a.ended_at || a.started_at || 0));
  return runs[0] ? Number(runs[0].task_score || 0) : null;
}
function getRunStopPayload(runId) {
  return getLatestAuditPayload('stop_task_time', 'task_run', runId) || null;
}
function isRunTimerStopped(run) {
  return !!(run && getRunStopPayload(run.id));
}
function getRunElapsedSeconds(run) {
  if (!run) return 0;
  const stopPayload = getRunStopPayload(run.id);
  if (stopPayload?.duration_seconds !== undefined && stopPayload?.duration_seconds !== null) {
    return Number(stopPayload.duration_seconds || 0);
  }
  return Math.max(0, Math.floor((Date.now() - new Date(run.started_at).getTime()) / 1000));
}
async function syncKidAggregateFields(kidId) {
  const finishedRuns = await select('task_runs', `?select=duration_seconds,task_score&kid_id=eq.${encodeURIComponent(kidId)}&status=eq.finished`);
  const totalTimeSeconds = finishedRuns.reduce((sum, run) => sum + Number(run.duration_seconds || 0), 0);
  const averageScore = finishedRuns.length ? finishedRuns.reduce((sum, run) => sum + Number(run.task_score || 0), 0) / finishedRuns.length : 0;
  await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, {
    total_score: averageScore,
    total_time_seconds: totalTimeSeconds
  });
}
function getMissionOrderLabelWithTimes(kid) {
  return getKidMissionPlanIds(kid).map((taskId, index) => {
    const task = state.tasks.find(item => item.id === taskId);
    const slot = getScheduleEntryByTaskId(kid, taskId);
    return `${index + 1}. ${task?.name || 'Unknown mission'}${slot ? ` (${fmtClockRange(slot.start, slot.end)})` : ''}`;
  }).join(' → ');
}
function stationSortValue(label = '') {
  const match = String(label).match(/A(\d+)/i);
  return match ? Number(match[1]) : 999;
}
function getDefaultMissionPlanIds(levelId) {
  return getTasksByLevel(levelId).map(task => task.id);
}
function getKidMissionPlanIds(kid) {
  if (!kid) return [];
  const payload = getLatestAuditPayload('set_kid_mission_plan', 'kid', kid.id);
  const levelTaskIds = getDefaultMissionPlanIds(kid.level_id);
  if (payload?.mission_ids?.length) {
    const valid = payload.mission_ids.filter(id => levelTaskIds.includes(id));
    const missing = levelTaskIds.filter(id => !valid.includes(id));
    return [...valid, ...missing];
  }
  const scheduledIds = getScheduledEntriesForKid(kid).map(entry => entry.task_id);
  if (scheduledIds.length) {
    const missing = levelTaskIds.filter(id => !scheduledIds.includes(id));
    return [...scheduledIds, ...missing];
  }
  return levelTaskIds;
}
function getFinishedTaskIdsByKid(kidId) {
  return [...new Set(getFinishedRunsByKid(kidId).map(run => run.task_id))];
}
function getPendingTaskIdsByKid(kid) {
  if (!kid) return [];
  const finishedIds = new Set(getFinishedTaskIdsByKid(kid.id));
  return getKidMissionPlanIds(kid).filter(taskId => !finishedIds.has(taskId));
}
function getPendingTasksByKid(kid) {
  return getPendingTaskIdsByKid(kid).map(taskId => state.tasks.find(task => task.id === taskId)).filter(Boolean);
}
function getCurrentTask(kid) {
  if (!kid) return null;
  const activeRun = getActiveRun(kid.id);
  if (activeRun) return state.tasks.find(task => task.id === activeRun.task_id) || null;
  const nextTaskId = getPendingTaskIdsByKid(kid)[0];
  return state.tasks.find(task => task.id === nextTaskId) || null;
}
function getEligibleTasksForCurrentUser(kid) {
  if (!kid || !state.user) return [];
  const activeRun = getActiveRun(kid.id);
  if (activeRun) {
    if (activeRun.moderator_id === state.user.id || state.user.role === 'admin') {
      const activeTask = state.tasks.find(task => task.id === activeRun.task_id);
      return activeTask ? [activeTask] : [];
    }
    return [];
  }
  const pendingTasks = getPendingTasksByKid(kid);
  if (state.user.role === 'admin') return pendingTasks;
  return pendingTasks.filter(task => getTaskModeratorId(task.id) === state.user.id);
}
function getResettableTasksForCurrentUser(kid) {
  if (!kid || !state.user) return [];
  const planTaskIds = getKidMissionPlanIds(kid);
  const tasks = planTaskIds.map(taskId => state.tasks.find(task => task.id === taskId)).filter(Boolean);
  if (state.user.role === 'admin') return tasks;
  return tasks.filter(task => getTaskModeratorId(task.id) === state.user.id);
}
function ensureSelectedTaskForKid(kid) {
  if (!kid) return;
  const eligible = getEligibleTasksForCurrentUser(kid);
  const selectedId = ui.selectedTaskByKid[kid.id];
  if (eligible.some(task => task.id === selectedId)) return;
  ui.selectedTaskByKid[kid.id] = eligible[0]?.id || null;
}
function ensureSelectedResetTaskForKid(kid) {
  if (!kid) return;
  const resettable = getResettableTasksForCurrentUser(kid);
  const selectedId = ui.selectedResetTaskByKid[kid.id];
  if (resettable.some(task => task.id === selectedId)) return;
  ui.selectedResetTaskByKid[kid.id] = resettable[0]?.id || null;
}
function getSelectedScoringTask(kid) {
  if (!kid) return null;
  ensureSelectedTaskForKid(kid);
  const selectedId = ui.selectedTaskByKid[kid.id];
  return state.tasks.find(task => task.id === selectedId) || null;
}
function getSelectedResetTask(kid) {
  if (!kid) return null;
  ensureSelectedResetTaskForKid(kid);
  const selectedId = ui.selectedResetTaskByKid[kid.id];
  return state.tasks.find(task => task.id === selectedId) || null;
}
function getMissionPlanLabel(kid) {
  return getKidMissionPlanIds(kid).map((taskId, index) => {
    const task = state.tasks.find(item => item.id === taskId);
    return `${index + 1}. ${task?.name || 'Mission inconnue'}`;
  }).join(' → ');
}
function compareBadge(a, b) {
  const av = String(a.badge_number || '').match(/\d+/)?.[0] || String(a.badge_number || '');
  const bv = String(b.badge_number || '').match(/\d+/)?.[0] || String(b.badge_number || '');
  return Number(av) - Number(bv) || String(a.badge_number || '').localeCompare(String(b.badge_number || ''));
}
function computeTaskScore(taskId, values) {
  return getCriteriaByTask(taskId).reduce((sum, criterion) => {
    return sum + Number(values[criterion.id] || 0) * Number(criterion.weight || 1);
  }, 0);
}
function ensureSelectedKid() {
  if (ui.selectedKidId && getKid(ui.selectedKidId)) return;
  ui.selectedKidId = filteredKids()[0]?.id || state.kids[0]?.id || null;
}
function filteredKids() {
  return state.kids.filter(kid => {
    const matchSearch = !ui.filters.search || kid.full_name.toLowerCase().includes(ui.filters.search.toLowerCase()) || String(kid.badge_number || '').toLowerCase().includes(ui.filters.search.toLowerCase());
    const matchLevel = ui.filters.level === 'all' || kid.level_id === ui.filters.level;
    const matchStatus = ui.filters.status === 'all' || kid.status === ui.filters.status;
    return matchSearch && matchLevel && matchStatus;
  }).sort((a, b) => compareBadge(a, b));
}
function leaderboardRows(levelId = 'all') {
  return state.kids.filter(kid => levelId === 'all' ? true : kid.level_id === levelId).slice().sort((a, b) => {
    const aTotals = getKidComputedTotals(a.id);
    const bTotals = getKidComputedTotals(b.id);
    if (Number(bTotals.averageScore) !== Number(aTotals.averageScore)) return Number(bTotals.averageScore) - Number(aTotals.averageScore);
    if (Number(aTotals.totalTimeSeconds) !== Number(bTotals.totalTimeSeconds)) return Number(aTotals.totalTimeSeconds) - Number(bTotals.totalTimeSeconds);
    return String(a.finished_at || '').localeCompare(String(b.finished_at || ''));
  });
}
function defaultDraftForTask(task) {
  const draft = {};
  getCriteriaByTask(task.id).forEach(criterion => { draft[criterion.id] = Number(criterion.min_value || 0); });
  return draft;
}
function getScoringAccessMessage(kid) {
  if (!kid || state.user?.role === 'admin') return '';
  const activeRun = getActiveRun(kid.id);
  if (activeRun && activeRun.moderator_id !== state.user.id) {
    return `missing ${kid.full_name} is not yet finished to jump to another mission`;
  }
  const eligible = getEligibleTasksForCurrentUser(kid);
  if (eligible.length) return '';
  const nextTask = getCurrentTask(kid);
  if (!nextTask) return '';
  const assignedModerator = getTaskModerator(nextTask.id);
  if (assignedModerator && assignedModerator.id !== state.user.id) {
    return `next mission named "${nextTask.name}" is with moderator "${assignedModerator.name}"`;
  }
  return `No pending mission assigned to moderator "${state.user.name}" for this kid`;
}
function openPage(page) {
  ui.page = page;
  if (state.user?.role !== 'admin' && page !== 'scoring') ui.page = 'scoring';
  render();
}
function setLoading(value) {
  ui.loading = value;
  render();
}
function isEditingForm() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag);
}
function initRefreshLoop() {
  if (refreshLoop) return;
  refreshLoop = setInterval(async () => {
    if (!state.user) return;
    if (['moderators', 'kids', 'levels', 'scoring'].includes(ui.page) && isEditingForm()) return;
    if (ui.page === 'active-board' && Date.now() - Number(ui.lastBootstrapAt || 0) < 60000) return;
    await loadBootstrap(true);
  }, 5000);
}
async function recalcKidTotals(kidId) {
  await syncKidAggregateFields(kidId);
}
async function logAction(actionType, entityType, entityId, payloadJson = {}) {
  if (!state.user) return;
  try {
    await insert('audit_logs', [{
      user_id: state.user.id,
      action_type: actionType,
      entity_type: entityType,
      entity_id: entityId || null,
      payload_json: payloadJson
    }], 'return=minimal');
  } catch (error) {
    console.warn('audit log skipped:', error.message);
  }
}
async function loadBootstrap(silent = false) {
  try {
    if (!silent) ui.loading = true;
    const [users, levels, tasks, criteria, kids, taskRuns, scoreDetails, auditLogs] = await Promise.all([
      select('users', '?select=id,name,email,role,active,created_at,updated_at&order=name.asc'),
      select('levels', '?select=*&order=order_index.asc'),
      select('tasks', '?select=*&order=level_id.asc,task_order.asc'),
      select('criteria', '?select=*&order=task_id.asc,display_order.asc'),
      select('kids', '?select=*&order=full_name.asc'),
      select('task_runs', '?select=*&order=started_at.desc'),
      select('score_details', '?select=*'),
      select('audit_logs', '?select=*&order=created_at.desc')
    ]);
    state.users = users;
    state.levels = levels;
    state.tasks = tasks;
    state.criteria = criteria;
    state.kids = kids;
    state.taskRuns = taskRuns;
    state.scoreDetails = scoreDetails;
    state.auditLogs = auditLogs;
    ensureSelectedKid();
    const kid = getKid(ui.selectedKidId);
    const task = getCurrentTask(kid);
    if (kid && task && !ui.scoringDraft[kid.id]) ui.scoringDraft[kid.id] = defaultDraftForTask(task);
    ui.error = '';
    ui.lastBootstrapAt = Date.now();
    initRefreshLoop();
  } catch (error) {
    ui.error = error.message;
  } finally {
    ui.loading = false;
    render();
  }
}
async function initializeApp() {
  state.user = loadSession();
  if (state.user) {
    ui.page = state.user.role === 'admin' ? 'dashboard' : 'scoring';
    await loadBootstrap();
  } else {
    render();
  }
}
async function login(username, password) {
  const normalized = String(username || '').trim().toLowerCase();
  const users = await select('users', `?select=id,name,email,role,active,password_hash&email=eq.${encodeURIComponent(normalized)}&limit=1`);
  const found = users[0];
  if (!found || !found.active) throw new Error('Identifiants invalides');
  if (String(found.password_hash || '') !== String(password || '')) throw new Error('Identifiants invalides');
  state.user = { id: found.id, name: found.name, email: found.email, role: found.role };
  saveSession(state.user);
  ui.page = found.role === 'admin' ? 'dashboard' : 'scoring';
  await loadBootstrap();
}
async function logout() {
  state.user = null;
  clearSession();
  if (refreshLoop) clearInterval(refreshLoop);
  refreshLoop = null;
  render();
}
async function runAction(actionFn) {
  try {
    setLoading(true);
    ui.error = '';
    await actionFn();
    await loadBootstrap(true);
  } catch (error) {
    ui.loading = false;
    ui.error = error.message;
    render();
    alert(error.message);
  }
}

async function createLevel(payload) {
  const rows = await insert('levels', [{
    name: payload.name,
    order_index: Number(payload.order_index),
    description: payload.description || ''
  }]);
  await logAction('create_level', 'level', rows[0]?.id, payload);
  await logAction('set_level_meta', 'level', rows[0]?.id, { co_name: payload.co_name || '' });
}
async function deleteLevel(levelId) {
  const kids = await select('kids', `?select=id&level_id=eq.${encodeURIComponent(levelId)}&limit=1`);
  if (kids.length) throw new Error('Ce niveau a encore des participants assignés');
  await deleteRow('levels', `?id=eq.${encodeURIComponent(levelId)}`);
  await logAction('delete_level', 'level', levelId, {});
}
async function createTask(payload) {
  const existing = getTasksByLevel(payload.level_id);
  const rows = await insert('tasks', [{
    level_id: payload.level_id,
    name: payload.name,
    description: payload.description || '',
    task_order: existing.length + 1,
    max_duration_seconds: Number(payload.max_duration_seconds || 180),
    is_active: true
  }]);
  await logAction('create_task', 'task', rows[0]?.id, payload);
  if (payload.moderator_id) {
    await logAction('assign_task_moderator', 'task', rows[0]?.id, { moderator_id: payload.moderator_id });
  }
}
async function deleteTask(taskId) {
  const runs = await select('task_runs', `?select=id&task_id=eq.${encodeURIComponent(taskId)}&limit=1`);
  if (runs.length) throw new Error('Impossible de supprimer une tâche déjà utilisée');
  await deleteRow('tasks', `?id=eq.${encodeURIComponent(taskId)}`);
  await logAction('delete_task', 'task', taskId, {});
}
async function createCriterion(payload) {
  const existing = await select('criteria', `?select=id&task_id=eq.${encodeURIComponent(payload.task_id)}`);
  const rows = await insert('criteria', [{
    task_id: payload.task_id,
    name: payload.name,
    input_type: payload.input_type,
    min_value: Number(payload.min_value),
    max_value: Number(payload.max_value),
    weight: Number(payload.weight),
    display_order: existing.length + 1
  }]);
  await logAction('create_criterion', 'criterion', rows[0]?.id, payload);
}
async function updateCriterion(criterionId, payload) {
  await patchRow('criteria', `?id=eq.${encodeURIComponent(criterionId)}`, {
    name: payload.name,
    input_type: payload.input_type,
    min_value: Number(payload.min_value),
    max_value: Number(payload.max_value),
    weight: Number(payload.weight)
  });
  await logAction('update_criterion', 'criterion', criterionId, payload);
}
async function deleteCriterion(criterionId) {
  await deleteRow('criteria', `?id=eq.${encodeURIComponent(criterionId)}`);
  await logAction('delete_criterion', 'criterion', criterionId, {});
}
async function createModerator(payload) {
  const username = String(payload.username || '').trim().toLowerCase();
  if (!username) throw new Error('Username requis');
  const existing = await select('users', `?select=id&email=eq.${encodeURIComponent(username)}&limit=1`);
  if (existing.length) throw new Error('Username déjà utilisé');
  const rows = await insert('users', [{
    name: payload.name,
    email: username,
    password_hash: String(payload.password || ''),
    role: 'moderator',
    active: true
  }]);
  await logAction('create_moderator', 'user', rows[0]?.id, { name: payload.name, username });
}
async function deleteModerator(userId) {
  const linkedTasks = state.tasks.filter(task => getTaskModeratorId(task.id) === userId);
  for (const task of linkedTasks) {
    await logAction('assign_task_moderator', 'task', task.id, { moderator_id: null });
  }
  await deleteRow('users', `?id=eq.${encodeURIComponent(userId)}`);
  await logAction('delete_moderator', 'user', userId, {});
}
async function saveLevelMeta(levelId, payload) {
  await logAction('set_level_meta', 'level', levelId, { co_name: payload.co_name || '' });
}
async function assignTaskModerator(taskId, moderatorId) {
  await logAction('assign_task_moderator', 'task', taskId, { moderator_id: moderatorId || null });
}
async function setKidMissionPlan(kidId, missionIds) {
  await logAction('set_kid_mission_plan', 'kid', kidId, { mission_ids: missionIds });
}
async function replicateCriteriaFromTask(sourceTaskId) {
  const sourceCriteria = getCriteriaByTask(sourceTaskId);
  if (!sourceCriteria.length) throw new Error('Source mission has no criteria to replicate');
  const targetTasks = state.tasks.filter(task => task.id !== sourceTaskId);
  for (const task of targetTasks) {
    const existing = await select('criteria', `?select=id&task_id=eq.${encodeURIComponent(task.id)}`);
    for (const row of existing) {
      await deleteRow('criteria', `?id=eq.${encodeURIComponent(row.id)}`);
    }
    const payload = sourceCriteria.map((criterion, index) => ({
      task_id: task.id,
      name: criterion.name,
      input_type: criterion.input_type,
      min_value: Number(criterion.min_value),
      max_value: Number(criterion.max_value),
      weight: Number(criterion.weight),
      display_order: index + 1
    }));
    await insert('criteria', payload, 'return=minimal');
  }
  await logAction('replicate_criteria_from_task', 'task', sourceTaskId, { target_count: targetTasks.length });
}
async function resetMissionScoring(kidId, taskId) {
  const runs = await select('task_runs', `?select=id,task_id,status&kid_id=eq.${encodeURIComponent(kidId)}&task_id=eq.${encodeURIComponent(taskId)}`);
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
    await deleteRow('task_runs', `?id=eq.${encodeURIComponent(run.id)}`);
  }
  ui.scoringDraft[kidId] = {};
  const kid = (await select('kids', `?select=*&id=eq.${encodeURIComponent(kidId)}&limit=1`))[0];
  if (kid) {
    const planIds = getKidMissionPlanIds(kid);
    const finishedRuns = (await select('task_runs', `?select=task_id,status,started_at&kid_id=eq.${encodeURIComponent(kidId)}&status=eq.finished&order=started_at.asc`));
    const finishedIds = new Set(finishedRuns.map(run => run.task_id));
    const firstUnfinishedIndex = planIds.findIndex(id => !finishedIds.has(id));
    const isDone = firstUnfinishedIndex === -1 && planIds.length > 0;
    await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, {
      status: isDone ? 'finished' : 'waiting',
      current_task_order: isDone ? planIds.length + 1 : Math.max(1, firstUnfinishedIndex + 1),
      finished_at: isDone ? kid.finished_at : null,
      total_score: 0,
      total_time_seconds: 0
    });
    await recalcKidTotals(kidId);
  }
  await logAction('reset_mission_scoring', 'task', taskId, { kid_id: kidId });
}
async function createKid(payload) {
  const rows = await insert('kids', [{
    full_name: payload.full_name,
    badge_number: payload.badge_number,
    level_id: payload.level_id
  }]);
  await logAction('create_kid', 'kid', rows[0]?.id, payload);
}
async function createKidsBulk(payload) {
  const lines = String(payload.rows || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('Aucune ligne à importer');
  const rows = lines.map((line, index) => {
    const parts = line.split(',').map(v => v.trim()).filter(Boolean);
    const full_name = parts[0];
    const badge_number = parts[1] || `K-${String(state.kids.length + index + 1).padStart(3, '0')}`;
    if (!full_name) throw new Error(`Ligne invalide: ${line}`);
    return { full_name, badge_number, level_id: payload.level_id };
  });
  await insert('kids', rows, 'return=minimal');
  await logAction('bulk_create_kids', 'kid', null, { count: rows.length, level_id: payload.level_id });
}
async function changeKidLevel(kidId, levelId) {
  const runs = await select('task_runs', `?select=id&kid_id=eq.${encodeURIComponent(kidId)}`);
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  }
  await deleteRow('task_runs', `?kid_id=eq.${encodeURIComponent(kidId)}`);
  await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, {
    level_id: levelId,
    status: 'waiting',
    current_task_order: 1,
    total_score: 0,
    total_time_seconds: 0,
    finished_at: null
  });
  await logAction('change_kid_level', 'kid', kidId, { level_id: levelId });
}
async function resetKid(kidId) {
  const runs = await select('task_runs', `?select=id&kid_id=eq.${encodeURIComponent(kidId)}`);
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  }
  await deleteRow('task_runs', `?kid_id=eq.${encodeURIComponent(kidId)}`);
  await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, {
    status: 'waiting',
    current_task_order: 1,
    total_score: 0,
    total_time_seconds: 0,
    finished_at: null
  });
  await logAction('reset_kid', 'kid', kidId, {});
}
async function deleteKid(kidId) {
  const runs = await select('task_runs', `?select=id&kid_id=eq.${encodeURIComponent(kidId)}`);
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  }
  await deleteRow('task_runs', `?kid_id=eq.${encodeURIComponent(kidId)}`);
  await deleteRow('kids', `?id=eq.${encodeURIComponent(kidId)}`);
  await logAction('delete_kid', 'kid', kidId, {});
}
async function resetAllKids() {
  const runs = await select('task_runs', '?select=id,kid_id');
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  }
  await deleteRow('task_runs', '?id=not.is.null');
  await patchRow('kids', '?id=not.is.null', {
    status: 'waiting',
    current_task_order: 1,
    total_score: 0,
    total_time_seconds: 0,
    finished_at: null
  });
  await logAction('reset_all_kids', 'kid', null, {});
}
async function deleteAllKids() {
  const runs = await select('task_runs', '?select=id');
  for (const run of runs) {
    await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  }
  await deleteRow('task_runs', '?id=not.is.null');
  await deleteRow('kids', '?id=not.is.null');
  await logAction('delete_all_kids', 'kid', null, {});
}
async function startTask(kidId, taskId = null) {
  const active = await select('task_runs', `?select=id&kid_id=eq.${encodeURIComponent(kidId)}&status=eq.in_progress&limit=1`);
  if (active.length) throw new Error('Une tâche est déjà en cours pour ce participant');
  const kid = (await select('kids', `?select=*&id=eq.${encodeURIComponent(kidId)}&limit=1`))[0];
  if (!kid) throw new Error('Participant introuvable');
  const blockedMessage = getScoringAccessMessage(kid);
  if (blockedMessage) throw new Error(blockedMessage);
  const eligibleTasks = getEligibleTasksForCurrentUser(kid);
  const task = eligibleTasks.find(item => item.id === taskId) || eligibleTasks[0] || (state.user.role === 'admin' ? getCurrentTask(kid) : null);
  if (!task) throw new Error('Aucune mission disponible pour ce participant');
  const rows = await insert('task_runs', [{
    kid_id: kidId,
    task_id: task.id,
    moderator_id: state.user.id,
    started_at: nowIso(),
    status: 'in_progress',
    duration_seconds: 0,
    task_score: 0
  }]);
  ui.selectedTaskByKid[kidId] = task.id;
  await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, { status: 'in_progress' });
  await logAction('start_task', 'task_run', rows[0]?.id, { kid_id: kidId, task_id: task.id });
}
async function stopTaskTime(kidId) {
  const run = (await select('task_runs', `?select=*&kid_id=eq.${encodeURIComponent(kidId)}&status=eq.in_progress&limit=1`))[0];
  if (!run) throw new Error('Aucune tâche active');
  if (isRunTimerStopped(run)) return;
  const duration = Math.max(1, getRunElapsedSeconds(run));
  await patchRow('task_runs', `?id=eq.${encodeURIComponent(run.id)}`, { duration_seconds: duration });
  await logAction('stop_task_time', 'task_run', run.id, { kid_id: kidId, task_id: run.task_id, duration_seconds: duration });
}
async function finishTask(kidId, values) {
  const run = (await select('task_runs', `?select=*&kid_id=eq.${encodeURIComponent(kidId)}&status=eq.in_progress&limit=1`))[0];
  if (!run) throw new Error('Aucune tâche active');
  const criteria = await select('criteria', `?select=*&task_id=eq.${encodeURIComponent(run.task_id)}&order=display_order.asc`);
  const endedAt = nowIso();
  const stopPayload = getRunStopPayload(run.id);
  const duration = stopPayload?.duration_seconds !== undefined && stopPayload?.duration_seconds !== null
    ? Math.max(1, Number(stopPayload.duration_seconds || 0))
    : Math.max(1, Math.floor((new Date(endedAt).getTime() - new Date(run.started_at).getTime()) / 1000));
  let taskScore = 0;
  const details = criteria.map(c => {
    const raw = Number(values?.[c.id] ?? c.min_value ?? 0);
    const weighted = raw * Number(c.weight || 1);
    taskScore += weighted;
    return {
      run_id: run.id,
      criterion_id: c.id,
      raw_value: raw,
      weighted_value: weighted
    };
  });
  await deleteRow('score_details', `?run_id=eq.${encodeURIComponent(run.id)}`);
  if (details.length) await insert('score_details', details, 'return=minimal');
  await patchRow('task_runs', `?id=eq.${encodeURIComponent(run.id)}`, {
    ended_at: endedAt,
    duration_seconds: duration,
    status: 'finished',
    task_score: taskScore
  });
  const kid = (await select('kids', `?select=*&id=eq.${encodeURIComponent(kidId)}&limit=1`))[0];
  const planIds = getKidMissionPlanIds(kid);
  const finishedTaskIds = new Set(getFinishedTaskIdsByKid(kidId));
  finishedTaskIds.add(run.task_id);
  const firstUnfinishedIndex = planIds.findIndex(taskId => !finishedTaskIds.has(taskId));
  const isDone = firstUnfinishedIndex === -1;
  await patchRow('kids', `?id=eq.${encodeURIComponent(kidId)}`, {
    status: isDone ? 'finished' : 'waiting',
    current_task_order: isDone ? planIds.length + 1 : firstUnfinishedIndex + 1,
    finished_at: isDone ? endedAt : null
  });
  await recalcKidTotals(kidId);
  ui.scoringDraft[kidId] = {};
  await logAction('finish_task', 'task_run', run.id, { kid_id: kidId, task_id: run.task_id, duration_seconds: duration, task_score: taskScore });
}
async function updateTaskRunResult(kidId, runId, payload) {
  if (state.user?.role !== 'admin') throw new Error('Only admin can edit mission history');
  const score = Number(payload.task_score);
  const durationSeconds = Math.max(0, parseDurationInput(payload.duration_seconds));
  if (Number.isNaN(score)) throw new Error('Invalid score value');
  await patchRow('task_runs', `?id=eq.${encodeURIComponent(runId)}`, {
    task_score: score,
    duration_seconds: durationSeconds
  });
  await syncKidAggregateFields(kidId);
  await logAction('admin_edit_task_run', 'task_run', runId, { kid_id: kidId, task_score: score, duration_seconds: durationSeconds });
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="title">Robotics Competition Scoring</div>
        <div class="subtitle">Connexion simple par username et mot de passe.</div>
        <div class="hero-note" style="margin-top:14px;">Compte admin par défaut : <b>admin / admin123</b></div>
        ${ui.error ? `<div class="notice" style="margin-top:14px;">${escapeHtml(ui.error)}</div>` : ''}
        <form id="login-form" class="login-grid" style="margin-top:18px;">
          <div><label>Username</label><input name="username" value="admin" required /></div>
          <div><label>Password</label><input name="password" type="password" value="admin123" required /></div>
          <div class="row">
            <button type="submit">Login</button>
            <button type="button" class="secondary" data-action="fill-demo" data-user="admin">Use admin</button>
          </div>
        </form>
      </div>
    </div>`;
}
function sidebarButton(page, label) {
  return `<button class="${ui.page === page ? 'active' : ''}" data-action="open-page" data-page="${page}">${label}</button>`;
}
function renderShell(content) {
  const adminOnly = state.user?.role === 'admin';
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">Robotics Live Score</div>
        <div class="brand-sub">Supabase direct mode</div>
        <div class="nav">
          ${adminOnly ? sidebarButton('dashboard', 'Dashboard') : ''}
          ${adminOnly ? sidebarButton('moderators', 'Moderators') : ''}
          ${adminOnly ? sidebarButton('levels', 'Levels / Missions / Criteria') : ''}
          ${adminOnly ? sidebarButton('kids', 'Kids Entry / Management') : ''}
          ${sidebarButton('scoring', 'Moderator Scoring')}
          ${adminOnly ? sidebarButton('leaderboard', 'Leaderboard') : ''}
          ${adminOnly ? sidebarButton('public-leaderboard', 'Public Leaderboard') : ''}
          ${adminOnly ? sidebarButton('active-board', 'Active Board') : ''}
          ${adminOnly ? sidebarButton('live', 'Live Status') : ''}
        </div>
        <div class="sidebar-footer">
          <div>${escapeHtml(state.user?.name || '')}</div>
          <div class="badge ${state.user?.role || 'moderator'}" style="margin-top:8px;">${escapeHtml(state.user?.role || '')}</div>
          <div class="footer-actions"><button class="ghost" data-action="logout">Logout</button></div>
        </div>
      </aside>
      <main class="main">
        ${ui.loading ? '<div class="notice" style="margin-bottom:14px;">Chargement…</div>' : ''}
        ${ui.error ? `<div class="notice" style="margin-bottom:14px;">${escapeHtml(ui.error)}</div>` : ''}
        ${content}
      </main>
    </div>`;
}

function renderDashboard() {
  const kidsFinished = state.kids.filter(k => k.status === 'finished').length;
  const kidsInProgress = state.kids.filter(k => k.status === 'in_progress').length;
  const kidsWaiting = state.kids.filter(k => k.status === 'waiting').length;
  const missionRows = state.tasks.map(task => ({
    task,
    level: getLevel(task.level_id),
    moderator: getTaskModerator(task.id)
  })).sort((a, b) => `${a.level?.name || ''} ${a.task.name}`.localeCompare(`${b.level?.name || ''} ${b.task.name}`));
  return `
    <div class="topbar"><div><div class="title">Event Dashboard</div><div class="subtitle">Vue centrale sans classement rapide ni audit log.</div></div></div>
    <div class="grid cols-4">
      <div class="card"><div class="muted">Kids</div><div class="metric">${state.kids.length}</div></div>
      <div class="card"><div class="muted">Waiting</div><div class="metric">${kidsWaiting}</div></div>
      <div class="card"><div class="muted">In progress</div><div class="metric">${kidsInProgress}</div></div>
      <div class="card"><div class="muted">Finished</div><div class="metric">${kidsFinished}</div></div>
    </div>
    <div class="card" style="margin-top:18px;">
      <h3>Moderators per mission</h3>
      <div class="table-wrap"><table><thead><tr><th>Level</th><th>Co-name</th><th>Mission</th><th>Moderator</th><th>Username</th></tr></thead><tbody>
        ${missionRows.map(({ task, level, moderator }) => `<tr><td>${escapeHtml(level?.name || '')}</td><td>${escapeHtml(getLevelCoName(level?.id) || '')}</td><td>${escapeHtml(task.name)}</td><td>${escapeHtml(moderator?.name || 'Unassigned')}</td><td>${escapeHtml(moderator?.email || '—')}</td></tr>`).join('') || '<tr><td colspan="5">No missions yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
}
function renderModeratorsPage() {
  const moderators = getModerators();
  return `
    <div class="topbar"><div><div class="title">Moderators</div><div class="subtitle">Créer les modérateurs avec nom, username et mot de passe.</div></div></div>
    <div class="grid cols-2">
      <div class="card"><h3>Add moderator</h3><form id="add-moderator-form" class="form-grid">
        <input name="name" placeholder="Moderator full name" required />
        <input name="username" placeholder="Username" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Add moderator</button>
      </form></div>
      <div class="card"><h3>Current moderators</h3><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Missions</th><th>Action</th></tr></thead><tbody>
        ${moderators.map(mod => `<tr><td>${escapeHtml(mod.name)}</td><td>${escapeHtml(mod.email)}</td><td>${state.tasks.filter(task => getTaskModeratorId(task.id) === mod.id).map(task => escapeHtml(task.name)).join(', ') || '—'}</td><td><button class="danger" data-action="delete-moderator" data-user-id="${mod.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4">No moderators yet.</td></tr>'}
      </tbody></table></div></div>
    </div>`;
}
function renderKidsPage() {
  const levelBlocks = state.levels.map(level => {
    const kids = state.kids.filter(kid => kid.level_id === level.id).sort(compareBadge);
    const tasks = getTasksByLevel(level.id);
    return `<div class="card" style="margin-top:18px;"><h3>${escapeHtml(level.name)}${getLevelCoName(level.id) ? ` — ${escapeHtml(getLevelCoName(level.id))}` : ''}</h3><div class="table-wrap"><table><thead><tr><th>Kid</th><th>Badge</th><th>Status</th><th>Mission order</th><th>Start / End</th><th>Score</th><th>Time</th><th>Actions</th></tr></thead><tbody>${kids.length ? kids.map(kid => { const plan = getKidMissionPlanIds(kid); const totals = getKidComputedTotals(kid.id); const scheduleStack = plan.map((taskId, index) => { const slot = getScheduleEntryByTaskId(kid, taskId); return `<div class="small">${index + 1}. ${slot ? fmtClockRange(slot.start, slot.end) : '—'}</div>`; }).join(''); return `<tr><td>${escapeHtml(kid.full_name)}</td><td>${escapeHtml(kid.badge_number)}</td><td><span class="badge ${kid.status}">${kid.status}</span></td><td><div class="grid" style="gap:8px;">${tasks.map((task, index) => `<select data-action="kid-mission-slot" data-kid-id="${kid.id}" data-slot-index="${index}">${tasks.map(optionTask => `<option value="${optionTask.id}" ${plan[index] === optionTask.id ? 'selected' : ''}>${index + 1}. ${escapeHtml(optionTask.name)}</option>`).join('')}</select>`).join('')}</div></td><td>${scheduleStack || '—'}</td><td>${Number(totals.averageScore || 0).toFixed(1)}</td><td>${fmtSeconds(totals.totalTimeSeconds)}</td><td><div class="row"><button class="secondary" data-action="select-kid" data-kid-id="${kid.id}">Open</button><button class="warning" data-action="reset-kid" data-kid-id="${kid.id}">Reset</button><button class="danger" data-action="delete-kid" data-kid-id="${kid.id}">Delete</button></div></td></tr>`; }).join('') : `<tr><td colspan="8">No kids in ${escapeHtml(level.name)} yet.</td></tr>`}</tbody></table></div></div>`;
  }).join('');
  return `
    <div class="topbar"><div><div class="title">Kids Entry / Management</div><div class="subtitle">Mission order follows the latest student distribution, with scheduled start/end slots shown next to each kid.</div></div><div class="row"><button class="warning" data-action="reset-all-kids">Reset all kids</button><button class="danger" data-action="delete-all-kids">Delete all kids</button></div></div>
    <div class="grid cols-2">
      <div class="card"><h3>Add one kid</h3><form id="add-kid-form" class="form-grid">
        <input name="full_name" placeholder="Kid full name" required />
        <input name="badge_number" placeholder="Badge number" required />
        <select name="level_id">${state.levels.map(l => `<option value="${l.id}">${escapeHtml(l.name)}${getLevelCoName(l.id) ? ` — ${escapeHtml(getLevelCoName(l.id))}` : ''}</option>`).join('')}</select>
        <button type="submit">Add kid</button>
      </form></div>
      <div class="card"><h3>Bulk add kids</h3><form id="bulk-add-kids-form" class="form-grid">
        <select name="level_id">${state.levels.map(l => `<option value="${l.id}">${escapeHtml(l.name)}${getLevelCoName(l.id) ? ` — ${escapeHtml(getLevelCoName(l.id))}` : ''}</option>`).join('')}</select>
        <button type="submit">Import list</button>
        <textarea class="full" name="rows" rows="8" placeholder="One kid per line. Format: Full Name, Badge Number
Example:
Sara Ali, K-001
Adam Noor, K-002"></textarea>
      </form><div class="small muted" style="margin-top:10px;">If the badge is omitted, it will be generated automatically.</div></div>
    </div>
    ${levelBlocks}`;
}

function renderLevelsPage() {
  const moderators = getModerators();
  return `
    <div class="topbar"><div><div class="title">Levels / Missions / Criteria</div><div class="subtitle">Chaque level s’ouvre à la demande pour une meilleure lisibilité. Tu peux aussi répliquer un set de critères vers toutes les missions.</div></div></div>
    <div class="card"><form id="add-level-form" class="form-grid">
      <input name="name" placeholder="Level name" required />
      <input name="order_index" type="number" min="1" placeholder="Order index" required />
      <input name="co_name" placeholder="Co-name" />
      <button type="submit">Add level</button>
      <input class="full" name="description" placeholder="Description" />
    </form></div>
    <div class="grid" style="margin-top:18px; gap:16px;">
      ${state.levels.map(level => {
        const expanded = !!ui.expandedLevels[level.id];
        return `
        <div class="level-card">
          <div class="level-header"><div><h3>${escapeHtml(level.name)}</h3><div class="muted">Co-name: ${escapeHtml(getLevelCoName(level.id) || '—')}</div><div class="small muted">${escapeHtml(level.description || '')}</div></div><div class="row"><button class="secondary" data-action="toggle-level-panel" data-level-id="${level.id}">${expanded ? 'Hide details' : 'Show details'}</button><button class="danger" data-action="delete-level" data-level-id="${level.id}">Delete level</button></div></div>
          ${expanded ? `
          <div class="task-block">
            <h4>Level co-name</h4>
            <div class="row">
              <input value="${escapeHtml(getLevelCoName(level.id) || '')}" data-action="level-co-name" data-level-id="${level.id}" placeholder="Co-name" />
              <button type="button" class="secondary" data-action="save-level-co-name" data-level-id="${level.id}">Save co-name</button>
            </div>
          </div>
          <div class="task-block">
            <h4>Add mission</h4>
            <form class="form-grid" data-form="add-task" data-level-id="${level.id}">
              <input name="name" placeholder="Mission name" required />
              <input name="max_duration_seconds" type="number" min="10" placeholder="Max duration (sec)" required />
              <select name="moderator_id"><option value="">Assign moderator later</option>${moderators.map(mod => `<option value="${mod.id}">${escapeHtml(mod.name)} (${escapeHtml(mod.email)})</option>`).join('')}</select>
              <button type="submit">Add mission</button>
              <textarea class="full" name="description" placeholder="Mission description"></textarea>
            </form>
          </div>
          ${getTasksByLevel(level.id).map(task => `
            <div class="task-block">
              <div class="row spread"><div><h4>${escapeHtml(task.name)}</h4><div class="small muted">${escapeHtml(task.description || '')}</div></div><div class="row"><button class="secondary" data-action="replicate-criteria-from-task" data-task-id="${task.id}">Replicate this criteria set to all missions</button><button class="danger" data-action="delete-task" data-task-id="${task.id}">Delete mission</button></div></div>
              <div class="row" style="margin-top:8px;"><div class="small muted">Assigned moderator</div><select data-action="assign-task-moderator" data-task-id="${task.id}"><option value="">Unassigned</option>${moderators.map(mod => `<option value="${mod.id}" ${getTaskModeratorId(task.id) === mod.id ? 'selected' : ''}>${escapeHtml(mod.name)} (${escapeHtml(mod.email)})</option>`).join('')}</select></div>
              <div class="small muted" style="margin-top:6px;">Max duration: ${task.max_duration_seconds}s</div>
              <div class="separator"></div>
              <h4>Criteria</h4>
              ${getCriteriaByTask(task.id).map(criterion => `
                <div class="criterion-mini">
                  <input value="${escapeHtml(criterion.name)}" data-action="criterion-name" data-criterion-id="${criterion.id}" />
                  <select data-action="criterion-type" data-criterion-id="${criterion.id}">
                    <option value="slider" ${criterion.input_type === 'slider' ? 'selected' : ''}>slider</option>
                    <option value="buttons" ${criterion.input_type === 'buttons' ? 'selected' : ''}>buttons</option>
                    <option value="numeric" ${criterion.input_type === 'numeric' ? 'selected' : ''}>numeric</option>
                  </select>
                  <input type="number" value="${criterion.min_value}" data-action="criterion-min" data-criterion-id="${criterion.id}" />
                  <input type="number" value="${criterion.max_value}" data-action="criterion-max" data-criterion-id="${criterion.id}" />
                  <input type="number" step="0.1" value="${criterion.weight}" data-action="criterion-weight" data-criterion-id="${criterion.id}" />
                  <button type="button" class="danger" data-action="delete-criterion" data-criterion-id="${criterion.id}">Delete</button>
                </div>`).join('') || '<div class="small muted">No criteria yet.</div>'}
              <form class="form-grid" data-form="add-criterion" data-task-id="${task.id}" style="margin-top:10px;">
                <input name="name" placeholder="Criterion name" required />
                <select name="input_type"><option value="slider">slider</option><option value="buttons">buttons</option><option value="numeric">numeric</option></select>
                <input name="min_value" type="number" value="0" required />
                <input name="max_value" type="number" value="10" required />
                <input name="weight" type="number" step="0.1" value="1" required />
                <button type="submit">Add criterion</button>
              </form>
            </div>`).join('')}
          ` : ''}
        </div>`;
      }).join('')}
    </div>`;
}
function renderCriteriaInput(criterion, currentValue) {
  if (criterion.input_type === 'buttons') {
    const values = Array.from({ length: Number(criterion.max_value) - Number(criterion.min_value) + 1 }, (_, i) => Number(criterion.min_value) + i);
    return `<div class="pill-group">${values.map(v => `<button type="button" class="${Number(currentValue) === v ? 'success' : 'secondary'}" data-action="set-criterion" data-criterion-id="${criterion.id}" data-value="${v}">${v}</button>`).join('')}</div>`;
  }
  if (criterion.input_type === 'numeric') {
    return `<input type="number" min="${criterion.min_value}" max="${criterion.max_value}" value="${currentValue}" data-action="set-criterion-input" data-criterion-id="${criterion.id}" />`;
  }
  return `<input type="range" min="${criterion.min_value}" max="${criterion.max_value}" value="${currentValue}" step="1" data-action="set-criterion-input" data-criterion-id="${criterion.id}" />`;
}
function renderScoringPage() {
  ensureSelectedKid();
  const kids = filteredKids();
  const kid = getKid(ui.selectedKidId) || kids[0] || null;
  const level = kid ? getLevel(kid.level_id) : null;
  const nextTask = kid ? getCurrentTask(kid) : null;
  const activeRun = kid ? getActiveRun(kid.id) : null;
  const elapsed = activeRun ? getRunElapsedSeconds(activeRun) : 0;
  const timerStopped = activeRun ? isRunTimerStopped(activeRun) : false;
  const accessMessage = kid ? getScoringAccessMessage(kid) : '';
  const eligibleTasks = kid ? getEligibleTasksForCurrentUser(kid) : [];
  const resettableTasks = kid ? getResettableTasksForCurrentUser(kid) : [];
  const task = kid ? getSelectedScoringTask(kid) : null;
  const resetTask = kid ? getSelectedResetTask(kid) : null;
  if (kid && task && !ui.scoringDraft[kid.id]) ui.scoringDraft[kid.id] = defaultDraftForTask(task);
  const draft = kid ? (ui.scoringDraft[kid.id] || {}) : {};
  const previewScore = task ? computeTaskScore(task.id, draft) : 0;
  const totals = kid ? getKidComputedTotals(kid.id) : { averageScore: 0, totalTimeSeconds: 0 };
  return `
    <div class="topbar"><div><div class="title">Moderator Scoring</div><div class="subtitle">Choose any eligible assigned mission, see each kid’s scheduled slot, and freeze the timer with Stop Time before finishing the mission.</div></div><div class="notice">Flow: pick kid → choose eligible mission → start mission → optional Stop Time → enter score → finish mission.</div></div>
    <div class="kids-layout">
      <div class="card">
        <div class="grid" style="gap:10px;">
          <input placeholder="Search by kid or badge" value="${escapeHtml(ui.filters.search)}" data-action="filter-search" />
          <select data-action="filter-level"><option value="all">All levels</option>${state.levels.map(level => `<option value="${level.id}" ${ui.filters.level === level.id ? 'selected' : ''}>${escapeHtml(level.name)}</option>`).join('')}</select>
          <select data-action="filter-status"><option value="all">All status</option><option value="waiting" ${ui.filters.status === 'waiting' ? 'selected' : ''}>waiting</option><option value="in_progress" ${ui.filters.status === 'in_progress' ? 'selected' : ''}>in_progress</option><option value="finished" ${ui.filters.status === 'finished' ? 'selected' : ''}>finished</option></select>
        </div>
        <div class="separator"></div>
        <div class="kid-list">
          ${kids.map(item => { const itemNextTask = getCurrentTask(item); const itemMod = itemNextTask ? getTaskModerator(itemNextTask.id) : null; return `<div class="kid-item ${item.id === kid?.id ? 'active' : ''}" data-action="select-kid" data-kid-id="${item.id}"><div class="row spread"><div><b>${escapeHtml(item.full_name)}</b><div class="small muted">${escapeHtml(item.badge_number)} · ${escapeHtml(getLevel(item.level_id)?.name || '')}</div></div><span class="badge ${item.status}">${item.status}</span></div><div class="row spread" style="margin-top:8px;"><span class="small">Next ordered: ${escapeHtml(itemNextTask?.name || 'Completed')}</span><span class="small">Mod: ${escapeHtml(itemMod?.name || '—')}</span></div></div>`; }).join('')}
        </div>
      </div>
      <div class="card">
        ${!kid ? '<div class="empty">Select a kid to start scoring.</div>' : `
          <div class="row spread"><div><div class="title" style="font-size:24px;">${escapeHtml(kid.full_name)}</div><div class="subtitle">${escapeHtml(kid.badge_number)} · ${escapeHtml(level?.name || '')}${getLevelCoName(level?.id) ? ` · ${escapeHtml(getLevelCoName(level?.id))}` : ''}</div></div><span class="badge ${kid.status}">${kid.status}</span></div>
          <div class="grid cols-3" style="margin-top:18px;"><div class="card"><div class="muted">Next ordered mission</div><div class="metric" style="font-size:22px;">${nextTask ? escapeHtml(nextTask.name) : 'Completed'}</div></div><div class="card"><div class="muted">Total score</div><div class="metric">${Number(totals.averageScore || 0).toFixed(1)}</div></div><div class="card"><div class="muted">Total time</div><div class="metric">${fmtSeconds(totals.totalTimeSeconds)}</div></div></div>
          <div class="card" style="margin-top:14px;"><div class="small muted">Mission order for this kid</div><div>${escapeHtml(getMissionOrderLabelWithTimes(kid) || '—')}</div></div>
          ${eligibleTasks.length ? `<div class="card" style="margin-top:14px;"><div class="small muted">Missions you can select now</div><div class="pill-group" style="margin-top:8px;">${eligibleTasks.map(mission => { const slot = getScheduleEntryByTaskId(kid, mission.id); return `<button type="button" class="${mission.id === task?.id ? 'success' : 'secondary'}" data-action="select-scoring-task" data-kid-id="${kid.id}" data-task-id="${mission.id}">${escapeHtml(mission.name)}${slot ? ` · ${fmtClockRange(slot.start, slot.end)}` : ''}</button>`; }).join('')}</div></div>` : ''}
          ${resettableTasks.length ? `<div class="card" style="margin-top:14px;"><div class="small muted">Mission result to reset</div><div class="row" style="margin-top:8px;"><select data-action="select-reset-task" data-kid-id="${kid.id}" class="grow">${resettableTasks.map(mission => { const runs = getRunsByKid(kid.id).filter(run => run.task_id === mission.id && run.status === 'finished'); const statusLabel = runs.length ? 'finished' : 'not started'; const slot = getScheduleEntryByTaskId(kid, mission.id); return `<option value="${mission.id}" ${mission.id === resetTask?.id ? 'selected' : ''}>${escapeHtml(mission.name)}${slot ? ` · ${fmtClockRange(slot.start, slot.end)}` : ''} — ${statusLabel}</option>`; }).join('')}</select><button class="danger" data-action="reset-mission-result" data-kid-id="${kid.id}">Reset this mission result</button></div></div>` : ''}
          ${accessMessage ? `<div class="notice" style="margin-top:16px;">${escapeHtml(accessMessage)}</div>` : ''}
          ${task && !accessMessage ? `<div class="separator"></div><div class="row spread"><div><h3>${escapeHtml(task.name)}</h3><div class="small muted">${escapeHtml(task.description || '')}</div><div class="small muted">Assigned moderator: ${escapeHtml(getTaskModerator(task.id)?.name || 'Unassigned')}</div><div class="small muted">Scheduled slot: ${(() => { const slot = getScheduleEntryByTaskId(kid, task.id); return slot ? fmtClockRange(slot.start, slot.end) : '—'; })()}</div></div><div><div class="timer">${fmtSeconds(elapsed)}</div>${timerStopped ? '<div class="small muted" style="margin-top:8px; text-align:center;">Time stopped</div>' : ''}</div></div><div class="footer-actions"><button class="success" data-action="start-task" data-kid-id="${kid.id}" data-task-id="${task.id}" ${activeRun ? 'disabled' : ''}>Start mission</button><button class="secondary" data-action="stop-task-time" data-kid-id="${kid.id}" ${!activeRun || timerStopped ? 'disabled' : ''}>Stop Time</button><button class="warning" data-action="finish-task" data-kid-id="${kid.id}" ${!activeRun ? 'disabled' : ''}>Finish mission</button><button class="ghost" data-action="reset-draft" data-kid-id="${kid.id}">Reset score input</button></div><div class="criteria-list">${getCriteriaByTask(task.id).map(criterion => { const value = draft[criterion.id] ?? Number(criterion.min_value || 0); return `<div class="criteria-row"><div class="criteria-head"><div><b>${escapeHtml(criterion.name)}</b><div class="small muted">${criterion.input_type} · range ${criterion.min_value}-${criterion.max_value} · weight ${criterion.weight}</div></div><div class="criteria-value">${value}</div></div>${renderCriteriaInput(criterion, value)}</div>`; }).join('') || '<div class="empty">No criteria configured for this mission yet.</div>'}</div><div class="card" style="margin-top:16px;"><div class="muted">Live mission score preview</div><div class="score-preview">${previewScore.toFixed(1)} / 100</div></div>` : !accessMessage ? '<div class="empty">This kid has finished all missions.</div>' : ''}
          <div class="separator"></div><h3>Mission history</h3><div class="table-wrap"><table><thead><tr><th>Mission</th><th>Moderator</th><th>Started</th><th>Ended</th><th>Duration</th><th>Score</th>${state.user?.role === 'admin' ? '<th>Admin edit</th>' : ''}</tr></thead><tbody>${getRunsByKid(kid.id).sort((a,b) => new Date(a.started_at) - new Date(b.started_at)).map(run => { const taskRef = state.tasks.find(t => t.id === run.task_id); const moderator = state.users.find(u => u.id === run.moderator_id); return `<tr><td>${escapeHtml(taskRef?.name || '')}</td><td>${escapeHtml(moderator?.name || '')}</td><td>${fmtDate(run.started_at)}</td><td>${fmtDate(run.ended_at)}</td><td>${state.user?.role === 'admin' ? `<input data-run-edit="duration" data-run-id="${run.id}" value="${fmtSeconds(run.duration_seconds)}" placeholder="HH:MM:SS" />` : fmtSeconds(run.duration_seconds)}</td><td>${state.user?.role === 'admin' ? `<input type="number" step="0.1" data-run-edit="score" data-run-id="${run.id}" value="${Number(run.task_score || 0).toFixed(1)}" />` : Number(run.task_score || 0).toFixed(1)}</td>${state.user?.role === 'admin' ? `<td><button class="secondary" data-action="save-run-edit" data-kid-id="${kid.id}" data-run-id="${run.id}">Save</button></td>` : ''}</tr>`; }).join('') || `<tr><td colspan="${state.user?.role === 'admin' ? '7' : '6'}">No mission run yet.</td></tr>`}</tbody></table></div>`}
      </div>
    </div>`;
}

function renderLeaderboardPage() {
  return `<div class="topbar"><div><div class="title">Leaderboard</div><div class="subtitle">Sorted by average score descending, then total time ascending.</div></div><select data-action="leaderboard-level"><option value="all">All levels</option>${state.levels.map(level => `<option value="${level.id}" ${ui.leaderboardLevel === level.id ? 'selected' : ''}>${escapeHtml(level.name)}</option>`).join('')}</select></div><div class="card"><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Kid</th><th>Badge</th><th>Level</th><th>Status</th><th>Total score</th><th>Total time</th><th>Finished at</th></tr></thead><tbody>${leaderboardRows(ui.leaderboardLevel).map((kid, idx) => { const totals = getKidComputedTotals(kid.id); return `<tr><td>${idx + 1}</td><td>${escapeHtml(kid.full_name)}</td><td>${escapeHtml(kid.badge_number)}</td><td>${escapeHtml(getLevel(kid.level_id)?.name || '')}</td><td><span class="badge ${kid.status}">${kid.status}</span></td><td>${Number(totals.averageScore || 0).toFixed(1)}</td><td>${fmtSeconds(totals.totalTimeSeconds)}</td><td>${fmtDate(kid.finished_at)}</td></tr>`; }).join('')}</tbody></table></div></div>`;
}
function renderPublicLeaderboardPage() {
  const rows = leaderboardRows(ui.leaderboardLevel).slice(0, 3);
  return `<div class="topbar"><div><div class="title">Public Leaderboard</div><div class="subtitle">Top three rows with total result, per-mission score/time, and finished status.</div></div><select data-action="leaderboard-level"><option value="all">All levels</option>${state.levels.map(level => `<option value="${level.id}" ${ui.leaderboardLevel === level.id ? 'selected' : ''}>${escapeHtml(level.name)}</option>`).join('')}</select></div><div class="card"><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Kid</th><th>Badge</th><th>Level</th><th>Status</th><th>Mission breakdown</th><th>Total score</th><th>Total time</th></tr></thead><tbody>${rows.map((kid, idx) => { const totals = getKidComputedTotals(kid.id); const plan = getKidMissionPlanIds(kid); const missionBreakdown = plan.map((taskId, orderIndex) => { const task = state.tasks.find(item => item.id === taskId); const run = getRunsByKid(kid.id).filter(item => item.task_id === taskId && item.status === 'finished').sort((a, b) => new Date(b.ended_at || b.started_at || 0) - new Date(a.ended_at || a.started_at || 0))[0]; const score = run ? Number(run.task_score || 0).toFixed(1) : '—'; const duration = run ? fmtSeconds(run.duration_seconds) : '—'; return `<div class="small"><b>${orderIndex + 1}. ${escapeHtml(task?.name || 'Mission')}</b> · score ${score} · time ${duration}</div>`; }).join(''); const isFullyFinished = kid.status === 'finished' || totals.finishedCount >= plan.length; return `<tr><td>${idx + 1}</td><td>${escapeHtml(kid.full_name)}</td><td>${escapeHtml(kid.badge_number)}</td><td>${escapeHtml(getLevel(kid.level_id)?.name || '')}</td><td>${isFullyFinished ? '<span class="badge finished">finished</span>' : '<span class="badge waiting">incomplete</span>'}</td><td>${missionBreakdown || '—'}</td><td>${Number(totals.averageScore || 0).toFixed(1)}</td><td>${fmtSeconds(totals.totalTimeSeconds)}</td></tr>`; }).join('') || '<tr><td colspan="8">No scored kids yet.</td></tr>'}</tbody></table></div></div>`;
}
function renderActiveBoard() {
  const stations = [...new Set(state.tasks.map(task => getTaskArea(task)))].sort((a, b) => stationSortValue(a) - stationSortValue(b) || a.localeCompare(b));
  const activeRuns = state.taskRuns.filter(run => run.status === 'in_progress');
  return `<div class="topbar"><div><div class="title">Active Board</div><div class="subtitle">Per station, showing only kids currently working. Auto-refresh window: 1 minute.</div></div></div><div class="grid cols-2">${stations.map(station => { const rows = activeRuns.map(run => ({ run, task: state.tasks.find(task => task.id === run.task_id), kid: getKid(run.kid_id) })).filter(item => item.task && getTaskArea(item.task) === station && item.kid); return `<div class="card"><div class="row spread"><h3>${escapeHtml(station)}</h3><span class="badge in_progress">${rows.length}</span></div><div class="grid" style="gap:10px; margin-top:12px;">${rows.length ? rows.map(({ run, task, kid }) => `<div class="kid-item"><b>${escapeHtml(kid.full_name)}</b><div class="small muted">${escapeHtml(kid.badge_number)} · ${escapeHtml(task.name)}</div><div class="small muted">Elapsed: ${fmtSeconds(getRunElapsedSeconds(run))}</div></div>`).join('') : '<div class="empty">No active kid at this station</div>'}</div></div>`; }).join('')}</div>`;
}
function renderLivePage() {
  return `<div class="topbar"><div><div class="title">Live Status Board</div><div class="subtitle">Operational status by kid state.</div></div></div><div class="grid cols-3">${['waiting','in_progress','finished'].map(status => `<div class="card"><div class="row spread"><h3>${status}</h3><span class="badge ${status}">${state.kids.filter(k => k.status === status).length}</span></div><div class="grid" style="gap:10px; margin-top:12px;">${state.kids.filter(k => k.status === status).map(k => { const totals = getKidComputedTotals(k.id); return `<div class="kid-item"><b>${escapeHtml(k.full_name)}</b><div class="small muted">${escapeHtml(getLevel(k.level_id)?.name || '')} · ${escapeHtml(k.badge_number)}</div><div class="row spread" style="margin-top:8px;"><span class="small">Task ${k.current_task_order}</span><span class="small">${Number(totals.averageScore || 0).toFixed(1)} pts</span></div></div>`; }).join('') || '<div class="empty">No kids in this group</div>'}</div></div>`).join('')}</div>`;
}
function render() {
  clearInterval(ticker);
  if (!state.user) return renderLogin();
  ensureSelectedKid();
  let body = '';
  if (ui.page === 'dashboard') body = renderDashboard();
  if (ui.page === 'moderators') body = renderModeratorsPage();
  if (ui.page === 'levels') body = renderLevelsPage();
  if (ui.page === 'kids') body = renderKidsPage();
  if (ui.page === 'scoring') body = renderScoringPage();
  if (ui.page === 'leaderboard') body = renderLeaderboardPage();
  if (ui.page === 'public-leaderboard') body = renderPublicLeaderboardPage();
  if (ui.page === 'active-board') body = renderActiveBoard();
  if (ui.page === 'live') body = renderLivePage();
  renderShell(body);
  ticker = setInterval(() => { if (ui.page === 'scoring' && getActiveRun(ui.selectedKidId) && !isEditingForm()) render(); }, 1000);
}

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  const data = new FormData(form);
  if (form.id === 'login-form') {
    try {
      await login(data.get('username'), data.get('password'));
    } catch (error) {
      ui.error = error.message;
      render();
    }
    return;
  }
  if (form.id === 'add-moderator-form') return runAction(() => createModerator({ name: data.get('name'), username: data.get('username'), password: data.get('password') }));
  if (form.id === 'add-kid-form') return runAction(() => createKid({ full_name: data.get('full_name'), badge_number: data.get('badge_number'), level_id: data.get('level_id') }));
  if (form.id === 'bulk-add-kids-form') return runAction(() => createKidsBulk({ level_id: data.get('level_id'), rows: data.get('rows') }));
  if (form.id === 'add-level-form') return runAction(() => createLevel({ name: data.get('name'), order_index: Number(data.get('order_index')), co_name: data.get('co_name'), description: data.get('description') }));
  if (form.dataset.form === 'add-task') return runAction(() => createTask({ level_id: form.dataset.levelId, name: data.get('name'), max_duration_seconds: Number(data.get('max_duration_seconds')), moderator_id: data.get('moderator_id'), description: data.get('description') }));
  if (form.dataset.form === 'add-criterion') return runAction(() => createCriterion({ task_id: form.dataset.taskId, name: data.get('name'), input_type: data.get('input_type'), min_value: Number(data.get('min_value')), max_value: Number(data.get('max_value')), weight: Number(data.get('weight')) }));
});

document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'fill-demo') {
    const form = document.getElementById('login-form');
    form.username.value = 'admin';
    form.password.value = 'admin123';
    return;
  }
  if (action === 'open-page') return openPage(target.dataset.page);
  if (action === 'logout') return logout();
  if (action === 'toggle-level-panel') { ui.expandedLevels[target.dataset.levelId] = !ui.expandedLevels[target.dataset.levelId]; return render(); }
  if (action === 'save-level-co-name') {
    const input = document.querySelector(`[data-action="level-co-name"][data-level-id="${target.dataset.levelId}"]`);
    return runAction(() => saveLevelMeta(target.dataset.levelId, { co_name: input?.value || '' }));
  }
  if (action === 'select-kid') { ui.selectedKidId = target.dataset.kidId; ui.page = 'scoring'; const selectedKid = getKid(ui.selectedKidId); ensureSelectedTaskForKid(selectedKid); ensureSelectedResetTaskForKid(selectedKid); return render(); }
  if (action === 'select-scoring-task') { ui.selectedTaskByKid[target.dataset.kidId] = target.dataset.taskId; return render(); }
  if (action === 'delete-moderator') { if (confirm('Delete this moderator?')) return runAction(() => deleteModerator(target.dataset.userId)); return; }
  if (action === 'reset-kid') { if (confirm('Reset this kid?')) return runAction(() => resetKid(target.dataset.kidId)); return; }
  if (action === 'reset-all-kids') { if (confirm('Reset all kids?')) return runAction(() => resetAllKids()); return; }
  if (action === 'delete-kid') { if (confirm('Delete this kid?')) return runAction(() => deleteKid(target.dataset.kidId)); return; }
  if (action === 'delete-all-kids') { if (confirm('Delete ALL kids? This cannot be undone.')) return runAction(() => deleteAllKids()); return; }
  if (action === 'delete-level') { if (confirm('Delete this level?')) return runAction(() => deleteLevel(target.dataset.levelId)); return; }
  if (action === 'delete-task') { if (confirm('Delete this task?')) return runAction(() => deleteTask(target.dataset.taskId)); return; }
  if (action === 'delete-criterion') { if (confirm('Delete this criterion?')) return runAction(() => deleteCriterion(target.dataset.criterionId)); return; }
  if (action === 'replicate-criteria-from-task') { if (confirm('Replicate this criteria set to all other missions?')) return runAction(() => replicateCriteriaFromTask(target.dataset.taskId)); return; }
  if (action === 'start-task') return runAction(() => startTask(target.dataset.kidId, target.dataset.taskId || null));
  if (action === 'stop-task-time') return runAction(() => stopTaskTime(target.dataset.kidId));
  if (action === 'finish-task') { const kid = getKid(target.dataset.kidId); return runAction(() => finishTask(target.dataset.kidId, ui.scoringDraft[kid.id] || {})); }
  if (action === 'reset-draft') {
    const kid = getKid(target.dataset.kidId);
    const task = getSelectedScoringTask(kid);
    if (!kid || !task) return;
    ui.scoringDraft[kid.id] = defaultDraftForTask(task);
    render();
    return;
  }
  if (action === 'reset-mission-result') {
    if (!confirm('Reset this mission result?')) return;
    const kid = getKid(target.dataset.kidId);
    const task = getSelectedResetTask(kid);
    if (!kid || !task) return;
    ui.scoringDraft[kid.id] = defaultDraftForTask(task);
    return runAction(() => resetMissionScoring(kid.id, task.id));
  }
  if (action === 'save-run-edit') {
    const row = target.closest('tr');
    const durationInput = row?.querySelector(`[data-run-edit="duration"][data-run-id="${target.dataset.runId}"]`);
    const scoreInput = row?.querySelector(`[data-run-edit="score"][data-run-id="${target.dataset.runId}"]`);
    return runAction(() => updateTaskRunResult(target.dataset.kidId, target.dataset.runId, {
      duration_seconds: durationInput?.value || '0',
      task_score: scoreInput?.value || '0'
    }));
  }
  if (action === 'set-criterion') { const kid = getKid(ui.selectedKidId); ui.scoringDraft[kid.id] ||= {}; ui.scoringDraft[kid.id][target.dataset.criterionId] = Number(target.dataset.value); render(); }
});

document.addEventListener('input', (e) => {
  const target = e.target;
  const action = target.dataset?.action;
  if (action === 'filter-search') { ui.filters.search = target.value; return render(); }
  if (action === 'set-criterion-input') { const kid = getKid(ui.selectedKidId); ui.scoringDraft[kid.id] ||= {}; ui.scoringDraft[kid.id][target.dataset.criterionId] = Number(target.value); return render(); }
});

document.addEventListener('change', async (e) => {
  const target = e.target;
  const action = target.dataset?.action;
  if (action === 'filter-level') { ui.filters.level = target.value; return render(); }
  if (action === 'filter-status') { ui.filters.status = target.value; return render(); }
  if (action === 'leaderboard-level') { ui.leaderboardLevel = target.value; return render(); }
  if (action === 'change-kid-level') return runAction(() => changeKidLevel(target.dataset.kidId, target.value));
  if (action === 'assign-task-moderator') return runAction(() => assignTaskModerator(target.dataset.taskId, target.value || null));
  if (action === 'select-reset-task') { ui.selectedResetTaskByKid[target.dataset.kidId] = target.value; return render(); }
  if (action === 'kid-mission-slot') {
    const kid = getKid(target.dataset.kidId);
    const currentPlan = getKidMissionPlanIds(kid);
    const slotIndex = Number(target.dataset.slotIndex);
    const selects = [...document.querySelectorAll(`[data-action="kid-mission-slot"][data-kid-id="${kid.id}"]`)];
    const missionIds = selects.map(el => el.value);
    const duplicateIndex = missionIds.findIndex((id, index) => index !== slotIndex && id === missionIds[slotIndex]);
    if (duplicateIndex >= 0) {
      missionIds[duplicateIndex] = currentPlan[slotIndex];
      selects[duplicateIndex].value = currentPlan[slotIndex];
    }
    return runAction(() => setKidMissionPlan(kid.id, missionIds));
  }
  const criterionId = target.dataset?.criterionId;
  if (!criterionId) return;
  const wrapper = target.closest('.criterion-mini');
  const [nameEl, typeEl, minEl, maxEl, weightEl] = wrapper.querySelectorAll('input, select');
  await runAction(() => updateCriterion(criterionId, {
    name: nameEl.value,
    input_type: typeEl.value,
    min_value: Number(minEl.value),
    max_value: Number(maxEl.value),
    weight: Number(weightEl.value)
  }));
});

initializeApp();
