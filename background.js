import {
  LOCAL_FILES_GROUP,
  getFullDomain,
  planWindowActions,
  pickColor,
  findDomainByGroupId,
} from './logic.js';

// タブイベント連発時にフル走査が多重実行されるのを防ぐデバウンス時間(ms)
const DEBOUNCE_MS = 250;

// --- 実行制御（デバウンス＋直列化） ----------------------------------------
// MV3のService Workerは複数イベントから groupTabsByDomain を非同期で呼び出すため、
// デバウンスで連発を1回にまとめ、isRunning で同時実行（競合書き込み）を防ぐ。
let debounceTimer = null;
let isRunning = false;
let pendingRun = false;

function scheduleGrouping(delay = DEBOUNCE_MS) {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runGrouping();
  }, delay);
}

async function runGrouping() {
  if (isRunning) {
    // 実行中に来た要求は、終了後にもう一度だけ走らせる
    pendingRun = true;
    return;
  }
  isRunning = true;
  try {
    await groupTabsByDomain();
  } catch (e) {
    console.error('グループ化処理でエラーが発生しました:', e);
  } finally {
    isRunning = false;
    if (pendingRun) {
      pendingRun = false;
      scheduleGrouping(0);
    }
  }
}

// --- ストレージ操作 --------------------------------------------------------

async function getStoredGroups() {
  const stored = await chrome.storage.local.get('tabGroups');
  // 構造: { [windowId]: { [domain]: { id, color, collapsed } } }
  return stored.tabGroups || {};
}

async function getToggleState() {
  const stored = await chrome.storage.local.get('domainToggle');
  return stored.domainToggle || {};
}

// --- メイン処理 ------------------------------------------------------------

// 全ウィンドウのタブを走査し、ウィンドウごと・ドメインごとにグループ化する。
async function groupTabsByDomain() {
  const toggleState = await getToggleState();
  const stored = await getStoredGroups();

  // 全タブを取得し、ウィンドウごとにバケツ分けする
  const allTabs = await chrome.tabs.query({});
  const tabsByWindow = new Map();
  for (const tab of allTabs) {
    if (!tabsByWindow.has(tab.windowId)) {
      tabsByWindow.set(tab.windowId, []);
    }
    tabsByWindow.get(tab.windowId).push(tab);
  }

  const newStored = {};

  for (const [windowId, tabs] of tabsByWindow) {
    const winKey = String(windowId);
    const winState = stored[winKey] || {};
    // 既存の色・開閉状態の記憶を引き継ぐ
    const newWinState = { ...winState };

    const { toGroup, toUngroup } = planWindowActions(tabs, toggleState);

    // グループ解除は1回のAPI呼び出しでまとめて実行（性能改善）
    if (toUngroup.length > 0) {
      try {
        await chrome.tabs.ungroup(toUngroup);
        // 解除したドメインの記憶状態を削除し、古いエントリの残留を防ぐ
        const ungroupedTabIds = new Set(toUngroup);
        for (const tab of tabs) {
          if (ungroupedTabIds.has(tab.id)) {
            const domain = getFullDomain(tab.url);
            if (domain) {
              delete newWinState[domain];
            }
          }
        }
      } catch (e) {
        console.error('グループ解除に失敗しました:', e);
      }
    }

    // 既に使われている色（このウィンドウ内）を集計
    const usedColors = Object.values(newWinState)
      .map((s) => s.color)
      .filter(Boolean);

    for (const { domain, tabIds } of toGroup) {
      try {
        await applyGroup(domain, tabIds, tabs, newWinState, usedColors);
      } catch (e) {
        console.error(`グループ化に失敗しました: ${domain} -`, e);
      }
    }

    newStored[winKey] = newWinState;
  }

  // 存在しなくなったウィンドウの状態は newStored に含まれないため自動的に整理される
  await chrome.storage.local.set({ tabGroups: newStored });
}

// 1ドメイン分のグループ化を適用し、newWinStateを更新する。
async function applyGroup(domain, tabIds, windowTabs, newWinState, usedColors) {
  let groupId = newWinState[domain]?.id;
  let color = newWinState[domain]?.color;
  let collapsed = newWinState[domain]?.collapsed;

  // 保存済みのグループIDが今も有効か確認する
  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = null; // 既に存在しない → 新規作成へフォールバック
    }
  }

  if (groupId != null) {
    // 既存グループにまだ属していないタブだけを追加（無駄なAPI呼び出しを避ける）
    const tabIdSet = new Set(tabIds);
    const tabIdsToAdd = windowTabs
      .filter((t) => tabIdSet.has(t.id) && t.groupId !== groupId)
      .map((t) => t.id);
    if (tabIdsToAdd.length > 0) {
      await chrome.tabs.group({ tabIds: tabIdsToAdd, groupId });
    }
  } else {
    // 新規グループを作成し、名前・色・開閉状態を初期化
    groupId = await chrome.tabs.group({ tabIds });
    color = pickColor(usedColors);
    usedColors.push(color);
    collapsed = false;
    const title = domain === LOCAL_FILES_GROUP ? '📁 Local Files' : domain;
    await chrome.tabGroups.update(groupId, { title, color, collapsed });
  }

  newWinState[domain] = { id: groupId, color, collapsed };
}

// --- イベントハンドラ（すべてトップレベルで一度だけ登録） ------------------

// グループの色・開閉状態がユーザー操作で変わったら記憶する
async function handleGroupUpdated(group) {
  const stored = await getStoredGroups();
  let changed = false;
  for (const winKey of Object.keys(stored)) {
    const winState = stored[winKey];
    const domain = findDomainByGroupId(winState, group.id);
    if (domain) {
      winState[domain] = {
        id: group.id,
        color: group.color,
        collapsed: group.collapsed,
      };
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ tabGroups: stored });
  }
}

// グループ自体が閉じられたら、ストレージから該当エントリを削除する
async function handleGroupRemoved(group) {
  const stored = await getStoredGroups();
  let changed = false;
  for (const winKey of Object.keys(stored)) {
    const winState = stored[winKey];
    const domain = findDomainByGroupId(winState, group.id);
    if (domain) {
      delete winState[domain];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ tabGroups: stored });
  }
}

// 起動・更新時
chrome.runtime.onInstalled.addListener(() => scheduleGrouping(0));
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => scheduleGrouping(0));
}

// タブの変化を監視（いずれもデバウンス経由で1回にまとめる）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    scheduleGrouping();
  }
});
chrome.tabs.onMoved.addListener(() => scheduleGrouping());
chrome.tabs.onRemoved.addListener(() => scheduleGrouping());
chrome.tabs.onAttached.addListener(() => scheduleGrouping());
chrome.tabs.onDetached.addListener(() => scheduleGrouping());

// グループ状態の変化を監視（トップレベルで一度だけ登録：リスナーリーク防止）
chrome.tabGroups.onUpdated.addListener((group) => {
  handleGroupUpdated(group).catch((e) =>
    console.error('グループ更新の保存に失敗しました:', e)
  );
});
chrome.tabGroups.onRemoved.addListener((group) => {
  handleGroupRemoved(group).catch((e) =>
    console.error('グループ削除の反映に失敗しました:', e)
  );
});
