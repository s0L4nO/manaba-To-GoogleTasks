// =============================================================================
// 定数・設定定義
// =============================================================================
const TARGET_PAGE_PREFIX = 'https://room.chuo-u.ac.jp/ct/home_library_query';
const TASKS_API_BASE = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

// =============================================================================
// アプリケーション状態
// =============================================================================
let currentAssignments = [];
let isSyncing = false;

// =============================================================================
// DOM要素参照
// =============================================================================
const viewLoading = document.getElementById('view-loading');
const viewInvalidUrl = document.getElementById('view-invalid-url');
const viewEmpty = document.getElementById('view-empty');
const viewError = document.getElementById('view-error');
const viewList = document.getElementById('view-list');

const errorMessageText = document.getElementById('error-message-text');
const btnReload = document.getElementById('btn-reload');

const checkSelectAll = document.getElementById('check-select-all');
const selectedCountBadge = document.getElementById('selected-count-badge');
const assignmentListEl = document.getElementById('assignment-list');

const syncProgressArea = document.getElementById('sync-progress-area');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressStatusText = document.getElementById('progress-status-text');
const syncSummaryBanner = document.getElementById('sync-summary-banner');
const btnSync = document.getElementById('btn-sync');

// =============================================================================
// 状態切り替えヘルパー
// =============================================================================
function showView(viewElement) {
  const views = [viewLoading, viewInvalidUrl, viewEmpty, viewError, viewList];
  for (const view of views) {
    if (view === viewElement) {
      view.classList.remove('hidden');
    } else {
      view.classList.add('hidden');
    }
  }
}

function showError(message) {
  errorMessageText.textContent = message;
  showView(viewError);
}

// =============================================================================
// manaba ページ内実行用スクレイピング関数（executeScript により注入）
// =============================================================================
function scrapeAssignmentsInTab() {
  const rows = document.querySelectorAll('table tr.row0, table tr.row1');
  const results = [];

  for (const row of rows) {
    const typeAnchor = row.querySelector('td:nth-child(1) a');
    const titleAnchor = row.querySelector('.myassignments-title a');
    const courseAnchor = row.querySelector('.mycourse-title a');
    
    // 行内の td.td-period（1つ目が受付開始、2つ目が締切）から締切セルを取得
    const periodCells = row.querySelectorAll('td.td-period');
    const periodCell = periodCells.length > 1 ? periodCells[1] : periodCells[0];

    // 必須要素が存在しないヘッダー行等はスキップ
    if (!titleAnchor || !courseAnchor || !periodCell) {
      continue;
    }

    const type = typeAnchor ? typeAnchor.textContent.trim() : '課題';
    const title = titleAnchor.textContent.trim();
    const courseName = courseAnchor.textContent.trim();
    const url = titleAnchor.href;
    const dueRawText = periodCell.textContent.trim();

    // 課題一意キー抽出: URLの pathname から /ct/([^/?#]+) を抽出
    let id = null;
    try {
      const parsedUrl = new URL(url);
      const match = parsedUrl.pathname.match(/\/ct\/([^/?#]+)/);
      if (match && match[1]) {
        id = match[1];
      }
    } catch (e) {
      id = null;
    }

    if (!id) {
      return {
        success: false,
        error: 'ID_EXTRACTION_FAILED',
        message: '課題IDの抽出に失敗しました。ページ構造が変更された可能性があります。'
      };
    }

    // 締切日時文字列（YYYY-MM-DD HH:mm）の解析
    const dateMatch = dueRawText.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    let dueTimeOnly = '23:59';
    let dueDateIso = '';

    if (dateMatch) {
      const datePart = dateMatch[1];
      dueTimeOnly = dateMatch[2];
      dueDateIso = `${datePart}T00:00:00.000Z`;
    } else {
      const datePart = dueRawText.split(/\s+/)[0] || '';
      dueDateIso = datePart ? `${datePart}T00:00:00.000Z` : '';
    }

    results.push({
      id,
      title,
      courseName,
      type,
      dueRawText,
      dueTimeOnly,
      dueDateIso,
      url
    });
  }

  return {
    success: true,
    assignments: results
  };
}

// =============================================================================
// 初期化・スクレイピングフロー
// =============================================================================
async function initialize() {
  showView(viewLoading);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      showError('アクティブなタブを取得できませんでした。');
      return;
    }

    const activeTab = tabs[0];
    if (!activeTab.url || !activeTab.url.startsWith(TARGET_PAGE_PREFIX)) {
      showView(viewInvalidUrl);
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: scrapeAssignmentsInTab
    });

    if (!injectionResults || injectionResults.length === 0 || !injectionResults[0].result) {
      showError('スクレイピング処理の実行結果を取得できませんでした。');
      return;
    }

    const scrapeResult = injectionResults[0].result;

    if (!scrapeResult.success) {
      showError(scrapeResult.message || '課題情報の取得に失敗しました。');
      return;
    }

    currentAssignments = scrapeResult.assignments;

    if (currentAssignments.length === 0) {
      showView(viewEmpty);
      return;
    }

    renderAssignmentList(currentAssignments);
    showView(viewList);
  } catch (err) {
    showError(`初期化処理中にエラーが発生しました: ${err.message}`);
  }
}

// =============================================================================
// UI レンダリング・操作系
// =============================================================================
function renderAssignmentList(assignments) {
  assignmentListEl.innerHTML = '';

  for (const item of assignments) {
    const li = document.createElement('li');
    li.className = 'assignment-item';
    li.id = `item-${item.id}`;

    const checkWrap = document.createElement('div');
    checkWrap.className = 'item-checkbox-wrap';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'item-checkbox';
    checkbox.dataset.id = item.id;
    checkbox.checked = true;
    checkbox.addEventListener('change', updateSelectionSummary);
    checkWrap.appendChild(checkbox);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'item-content';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'item-meta';

    const courseSpan = document.createElement('span');
    courseSpan.className = 'course-name';
    courseSpan.textContent = `[${item.courseName}]`;
    courseSpan.title = item.courseName;

    const typeSpan = document.createElement('span');
    typeSpan.className = 'assignment-type-badge';
    typeSpan.textContent = item.type;

    metaDiv.appendChild(courseSpan);
    metaDiv.appendChild(typeSpan);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'assignment-title';
    titleDiv.textContent = item.title;
    titleDiv.title = item.title;

    const footerDiv = document.createElement('div');
    footerDiv.className = 'item-footer';

    const dueSpan = document.createElement('span');
    dueSpan.className = 'due-text';
    dueSpan.textContent = `締切: ${item.dueRawText}`;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'status-badge status-unregistered';
    statusSpan.id = `status-${item.id}`;
    statusSpan.textContent = '未登録';

    footerDiv.appendChild(dueSpan);
    footerDiv.appendChild(statusSpan);

    contentDiv.appendChild(metaDiv);
    contentDiv.appendChild(titleDiv);
    contentDiv.appendChild(footerDiv);

    li.appendChild(checkWrap);
    li.appendChild(contentDiv);

    assignmentListEl.appendChild(li);
  }

  checkSelectAll.checked = true;
  updateSelectionSummary();
}

function updateSelectionSummary() {
  const checkboxes = document.querySelectorAll('.item-checkbox');
  let selectedCount = 0;

  for (const cb of checkboxes) {
    if (cb.checked) {
      selectedCount++;
    }
  }

  selectedCountBadge.textContent = `${selectedCount} / ${checkboxes.length} 件選択中`;
  btnSync.disabled = isSyncing || selectedCount === 0;

  if (checkboxes.length > 0) {
    checkSelectAll.checked = selectedCount === checkboxes.length;
    checkSelectAll.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
  }
}

function updateItemStatusBadge(assignmentId, statusType, text) {
  const badge = document.getElementById(`status-${assignmentId}`);
  if (!badge) return;

  badge.className = `status-badge status-${statusType}`;
  badge.textContent = text;
}

// =============================================================================
// Google Identity API & Tasks API 通信層
// =============================================================================
function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

async function fetchWithAuth(url, options = {}, isRetry = false) {
  const token = await getAuthToken(true);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401 && !isRetry) {
    await removeCachedAuthToken(token);
    return fetchWithAuth(url, options, true);
  }

  return response;
}

// 既存タスク全件取得（nextPageToken 走査による漏れのない ID 集合構築）
async function fetchExistingTaskIds(dueMinIso) {
  const existingIdSet = new Set();
  let pageToken = '';

  do {
    const url = new URL(TASKS_API_BASE);
    url.searchParams.set('dueMin', dueMinIso);
    url.searchParams.set('showCompleted', 'true');
    url.searchParams.set('showHidden', 'true');
    url.searchParams.set('maxResults', '100');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetchWithAuth(url.toString(), { method: 'GET' });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`既存タスクの取得に失敗しました (${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (data.items && Array.isArray(data.items)) {
      for (const task of data.items) {
        if (task.notes) {
          const match = task.notes.match(/\[manaba_id:([^\]\s]+)\]/);
          if (match && match[1]) {
            existingIdSet.add(match[1]);
          }
        }
      }
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return existingIdSet;
}

// 新規タスクの登録（tasks.insert）
async function insertTask(assignment) {
  const title = `[${assignment.courseName}] ${assignment.title} (${assignment.type}) [~${assignment.dueTimeOnly}]`;
  const notes = [
    `■ 締切日時: ${assignment.dueRawText}`,
    `■ コース名: ${assignment.courseName}`,
    `■ 課題URL: ${assignment.url}`,
    '----------------------------------------',
    `[manaba_id:${assignment.id}]`
  ].join('\n');

  const body = {
    title: title,
    due: assignment.dueDateIso,
    notes: notes
  };

  const response = await fetchWithAuth(TASKS_API_BASE, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`タスク登録に失敗しました (${response.status}): ${errText}`);
  }

  return await response.json();
}

// =============================================================================
// 同期実行フロー
// =============================================================================
async function handleSync() {
  if (isSyncing) return;

  const checkboxes = document.querySelectorAll('.item-checkbox:checked');
  const selectedIds = new Set();
  for (const cb of checkboxes) {
    selectedIds.add(cb.dataset.id);
  }

  const targets = currentAssignments.filter((item) => selectedIds.has(item.id));
  if (targets.length === 0) return;

  // 同期開始UI状態へ更新
  isSyncing = true;
  btnSync.disabled = true;
  checkSelectAll.disabled = true;
  for (const cb of document.querySelectorAll('.item-checkbox')) {
    cb.disabled = true;
  }
  syncSummaryBanner.classList.add('hidden');
  syncProgressArea.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressStatusText.textContent = '既存タスクを確認中...';

  try {
    // 1. 最も古い締切日を dueMin として算出
    let earliestDueDate = targets[0].dueDateIso;
    for (const item of targets) {
      if (item.dueDateIso && (!earliestDueDate || item.dueDateIso < earliestDueDate)) {
        earliestDueDate = item.dueDateIso;
      }
    }

    if (!earliestDueDate) {
      const today = new Date().toISOString().slice(0, 10);
      earliestDueDate = `${today}T00:00:00.000Z`;
    }

    // 2. 既存タスク一覧を取得
    const existingIdSet = await fetchExistingTaskIds(earliestDueDate);

    // 3. 突合および送信対象の選定
    const toInsertList = [];
    let skippedCount = 0;

    for (const item of targets) {
      if (existingIdSet.has(item.id)) {
        updateItemStatusBadge(item.id, 'skipped', '登録済（スキップ）');
        skippedCount++;
      } else {
        toInsertList.push(item);
      }
    }

    let successCount = 0;
    let failedCount = 0;
    const totalCount = targets.length;
    let processedCount = skippedCount;

    const initialPercent = Math.round((processedCount / totalCount) * 100);
    progressBarFill.style.width = `${initialPercent}%`;
    progressStatusText.textContent = `同期中 (${processedCount}/${totalCount})...`;

    // 全て登録済みだった場合の早期終了判定
    if (toInsertList.length === 0) {
      syncSummaryBanner.className = 'sync-summary-banner warning';
      syncSummaryBanner.textContent = '選択された課題はすべて登録済みでした。';
      syncSummaryBanner.classList.remove('hidden');
    } else {
      // 4. レートリミットを回避するため for...of ループで順次（直列）送信
      for (const item of toInsertList) {
        updateItemStatusBadge(item.id, 'syncing', '登録中...');

        try {
          await insertTask(item);
          updateItemStatusBadge(item.id, 'success', '追加完了');
          existingIdSet.add(item.id);
          successCount++;
        } catch (postErr) {
          console.error(`Task insert error [${item.id}]:`, postErr);
          updateItemStatusBadge(item.id, 'failed', '追加失敗');
          failedCount++;
        }

        processedCount++;
        const currentPercent = Math.round((processedCount / totalCount) * 100);
        progressBarFill.style.width = `${currentPercent}%`;
        progressStatusText.textContent = `同期中 (${processedCount}/${totalCount})...`;
      }

      // 結果サマリーの表示
      syncSummaryBanner.classList.remove('hidden');
      if (failedCount === 0) {
        syncSummaryBanner.className = 'sync-summary-banner success';
        syncSummaryBanner.textContent = `同期完了: ${successCount}件追加、${skippedCount}件スキップ`;
      } else {
        syncSummaryBanner.className = 'sync-summary-banner warning';
        syncSummaryBanner.textContent = `一部完了: ${successCount}件追加、${skippedCount}件スキップ、${failedCount}件失敗`;
      }
    }
  } catch (err) {
    console.error('Sync failed:', err);
    syncSummaryBanner.className = 'sync-summary-banner error';
    syncSummaryBanner.textContent = `同期エラー: ${err.message}`;
    syncSummaryBanner.classList.remove('hidden');
  } finally {
    isSyncing = false;
    btnSync.disabled = false;
    checkSelectAll.disabled = false;
    for (const cb of document.querySelectorAll('.item-checkbox')) {
      cb.disabled = false;
    }
    updateSelectionSummary();
  }
}

// =============================================================================
// イベントリスナー登録
// =============================================================================
checkSelectAll.addEventListener('change', () => {
  const isChecked = checkSelectAll.checked;
  const checkboxes = document.querySelectorAll('.item-checkbox');
  for (const cb of checkboxes) {
    cb.checked = isChecked;
  }
  updateSelectionSummary();
});

btnSync.addEventListener('click', handleSync);

btnReload.addEventListener('click', () => {
  initialize();
});

// 初期化実行
document.addEventListener('DOMContentLoaded', initialize);