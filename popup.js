import { countDomains, selectPopupDomains } from './logic.js';

// ON/OFF状態をchrome.storage.localから取得
async function getDomainToggleState() {
  const result = await chrome.storage.local.get('domainToggle');
  return result.domainToggle || {};
}

// ON/OFF状態をchrome.storage.localに保存（最新状態を読んでからマージ）
async function setDomainToggleState(domain, state) {
  const current = await getDomainToggleState();
  current[domain] = state;
  await chrome.storage.local.set({ domainToggle: current });
}

// 現在ウィンドウのタブからトグル対象ドメイン一覧を取得
async function getDomainsWithTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const domainCount = countDomains(tabs);
  const toggleState = await getDomainToggleState();
  return selectPopupDomains(domainCount, toggleState);
}

// UI描画
async function renderDomainList() {
  const domainListElem = document.getElementById('domainList');
  const domains = await getDomainsWithTabs();
  const toggleState = await getDomainToggleState();

  // 一旦組み立ててから一括差し替え（再描画コストを抑える）
  const fragment = document.createDocumentFragment();
  domains.forEach((domain) => {
    const item = document.createElement('div');
    item.className = 'domain-item';

    const label = document.createElement('span');
    label.textContent = domain; // textContentでXSSを防止

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = !!toggleState[domain];
    toggle.addEventListener('change', () => {
      setDomainToggleState(domain, toggle.checked).catch((e) =>
        console.error('トグル状態の保存に失敗しました:', e)
      );
    });

    item.appendChild(label);
    item.appendChild(toggle);
    fragment.appendChild(item);
  });

  domainListElem.replaceChildren(fragment);
}

// 連続イベントでの過剰な再描画を防ぐデバウンス
let renderTimer = null;
function scheduleRender() {
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
  }
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderDomainList().catch((e) =>
      console.error('一覧の描画に失敗しました:', e)
    );
  }, 150);
}

// タブが変化したらリストを再描画
chrome.tabs.onUpdated.addListener(scheduleRender);
chrome.tabs.onRemoved.addListener(scheduleRender);
chrome.tabs.onCreated.addListener(scheduleRender);

// 初回は遅延なしで即描画する
document.addEventListener('DOMContentLoaded', () => {
  renderDomainList().catch((e) =>
    console.error('一覧の描画に失敗しました:', e)
  );
});
