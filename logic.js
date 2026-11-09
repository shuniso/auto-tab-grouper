// 純粋ロジック（chrome.* 非依存）。background.js / popup.js / テストで共有する。

// ローカルファイル(file://)を一括管理するための特別なキー
export const LOCAL_FILES_GROUP = 'LOCAL_FILES_GROUP';

// Chromeが提供する利用可能なグループの色
export const COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
];

// グループに属していないことを表すgroupId（chrome.tabGroups.TAB_GROUP_ID_NONE）
const TAB_GROUP_ID_NONE = -1;

// URLからグループ化のキー（ホスト名 or LOCAL_FILES_GROUP）を抽出する。
// グループ化対象外（chrome://, データURL, 無効なURL等）は null を返す。
export function getFullDomain(url) {
  if (typeof url !== 'string' || url === '') {
    return null;
  }
  if (url.startsWith('file://')) {
    return LOCAL_FILES_GROUP;
  }
  let urlObject;
  try {
    urlObject = new URL(url);
  } catch {
    return null;
  }
  // http(s) のみをグループ化対象とする（chrome://, about:, data: 等は除外）
  if (urlObject.protocol === 'http:' || urlObject.protocol === 'https:') {
    return urlObject.hostname || null;
  }
  return null;
}

// タブ配列からドメインごとの件数を集計する（popup表示用）。
export function countDomains(tabs) {
  const counts = {};
  for (const tab of tabs) {
    const domain = getFullDomain(tab.url);
    if (domain === null || domain === LOCAL_FILES_GROUP) {
      continue;
    }
    counts[domain] = (counts[domain] || 0) + 1;
  }
  return counts;
}

// popupに表示するドメイン一覧を決定する。
// 「2件以上開いている」または「トグルON」のドメインを対象とし、LOCAL_FILES_GROUPは除外。
export function selectPopupDomains(domainCount, toggleState) {
  const result = new Set();
  for (const [domain, count] of Object.entries(domainCount)) {
    if (count >= 2) {
      result.add(domain);
    }
  }
  for (const [domain, on] of Object.entries(toggleState)) {
    if (on) {
      result.add(domain);
    }
  }
  result.delete(LOCAL_FILES_GROUP);
  return Array.from(result);
}

// 1ウィンドウ分のタブとトグル状態から、グループ化／解除の計画を立てる（純粋関数）。
// 戻り値: { toGroup: [{domain, tabIds}], toUngroup: [tabId] }
export function planWindowActions(tabs, toggleState) {
  const domainToTabs = new Map(); // domain -> [{id, groupId}]
  for (const tab of tabs) {
    const domain = getFullDomain(tab.url);
    if (domain === null) {
      continue;
    }
    if (!domainToTabs.has(domain)) {
      domainToTabs.set(domain, []);
    }
    domainToTabs.get(domain).push({ id: tab.id, groupId: tab.groupId });
  }

  const toGroup = [];
  const toUngroup = [];

  for (const [domain, tabsForDomain] of domainToTabs) {
    // ローカルファイルはトグルに関係なく常にON扱い
    const isOn = domain === LOCAL_FILES_GROUP || !!toggleState[domain];
    const hasMultiple = tabsForDomain.length >= 2;

    if (isOn && hasMultiple) {
      // グループ化対象
      toGroup.push({ domain, tabIds: tabsForDomain.map((t) => t.id) });
    } else {
      // OFF、または2タブ未満 → 現在グループに属しているタブのみ解除対象にする。
      // 単独タブのグループを残すと、そのタブを閉じた時にChromeの「保存済みタブグループ」へ
      // 閉じたグループとして残り続けるため、解除（＝保存済みグループごと削除）しておく。
      for (const t of tabsForDomain) {
        if (t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE) {
          toUngroup.push(t.id);
        }
      }
    }
  }

  return { toGroup, toUngroup };
}

// ドメインに対応するグループのタイトル。
export function groupTitleFor(domain) {
  return domain === LOCAL_FILES_GROUP ? '📁 Local Files' : domain;
}

// ウィンドウ内の既存グループから、同じタイトルで再利用できるグループを選ぶ。
// 新規作成のたびに保存済みタブグループが増えるのを防ぐため、作成より再利用を優先する。
// 同名が複数ある場合は対象タブを最も多く含むものを選ぶ。該当なしは null。
export function findReusableGroup(groups, title, domainTabs) {
  let best = null;
  let bestCount = -1;
  for (const group of groups) {
    if (group.title !== title) {
      continue;
    }
    const count = domainTabs.filter((t) => t.groupId === group.id).length;
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best;
}

// 既に使われている色を避けて新しいグループ色を選ぶ。
// 全色使用済みの場合は rng を使ってランダムに選ぶ。
export function pickColor(usedColors, rng = Math.random) {
  const available = COLORS.filter((c) => !usedColors.includes(c));
  if (available.length > 0) {
    return available[Math.floor(rng() * available.length)];
  }
  return COLORS[Math.floor(rng() * COLORS.length)];
}

// 1ウィンドウ分の状態マップからグループIDに対応するドメインを逆引きする。
export function findDomainByGroupId(winState, groupId) {
  for (const domain of Object.keys(winState)) {
    if (winState[domain]?.id === groupId) {
      return domain;
    }
  }
  return null;
}
