import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_FILES_GROUP,
  COLORS,
  getFullDomain,
  countDomains,
  selectPopupDomains,
  planWindowActions,
  pickColor,
  findDomainByGroupId,
  groupTitleFor,
  findReusableGroup,
} from '../logic.js';

// --- getFullDomain ---------------------------------------------------------

test('getFullDomain: httpsのホスト名を返す', () => {
  assert.equal(getFullDomain('https://example.com/path?q=1'), 'example.com');
});

test('getFullDomain: サブドメインを含めて返す', () => {
  assert.equal(getFullDomain('https://www.sub.example.com/'), 'www.sub.example.com');
});

test('getFullDomain: ポート番号はホスト名に含めない', () => {
  assert.equal(getFullDomain('http://localhost:3000/app'), 'localhost');
});

test('getFullDomain: file:// は専用キーを返す', () => {
  assert.equal(getFullDomain('file:///home/user/page.html'), LOCAL_FILES_GROUP);
});

test('getFullDomain: chrome:// はグループ対象外(null)', () => {
  assert.equal(getFullDomain('chrome://extensions'), null);
});

test('getFullDomain: chrome-extension:// はグループ対象外(null)', () => {
  assert.equal(getFullDomain('chrome-extension://abcdef/popup.html'), null);
});

test('getFullDomain: 無効なURLはnull', () => {
  assert.equal(getFullDomain('not a url'), null);
});

test('getFullDomain: 空文字・undefined・非文字列はnull', () => {
  assert.equal(getFullDomain(''), null);
  assert.equal(getFullDomain(undefined), null);
  assert.equal(getFullDomain(null), null);
  assert.equal(getFullDomain(123), null);
});

// --- countDomains ----------------------------------------------------------

test('countDomains: ドメインごとの件数を数える', () => {
  const tabs = [
    { url: 'https://a.com/1' },
    { url: 'https://a.com/2' },
    { url: 'https://b.com/' },
    { url: 'chrome://settings' }, // 対象外
  ];
  assert.deepEqual(countDomains(tabs), { 'a.com': 2, 'b.com': 1 });
});

// --- selectPopupDomains ----------------------------------------------------

test('selectPopupDomains: 2件以上のドメインを含む', () => {
  const result = selectPopupDomains({ 'a.com': 2, 'b.com': 1 }, {});
  assert.deepEqual(result.sort(), ['a.com']);
});

test('selectPopupDomains: 1件でもONなら残す', () => {
  const result = selectPopupDomains({ 'a.com': 1 }, { 'a.com': true });
  assert.deepEqual(result, ['a.com']);
});

test('selectPopupDomains: LOCAL_FILES_GROUP は除外する', () => {
  const result = selectPopupDomains(
    { [LOCAL_FILES_GROUP]: 5 },
    { [LOCAL_FILES_GROUP]: true }
  );
  assert.deepEqual(result, []);
});

test('selectPopupDomains: 重複しない', () => {
  const result = selectPopupDomains({ 'a.com': 3 }, { 'a.com': true });
  assert.deepEqual(result, ['a.com']);
});

// --- planWindowActions -----------------------------------------------------

test('planWindowActions: ONかつ2タブ以上はグループ化対象', () => {
  const tabs = [
    { id: 1, url: 'https://a.com/1', groupId: -1 },
    { id: 2, url: 'https://a.com/2', groupId: -1 },
  ];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'a.com': true });
  assert.deepEqual(toGroup, [{ domain: 'a.com', tabIds: [1, 2] }]);
  assert.deepEqual(toUngroup, []);
});

test('planWindowActions: ONでも1タブのみでグループ外なら何もしない', () => {
  const tabs = [{ id: 1, url: 'https://a.com/1', groupId: -1 }];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'a.com': true });
  assert.deepEqual(toGroup, []);
  assert.deepEqual(toUngroup, []);
});

test('planWindowActions: ONで1タブに減ったグループ中のタブは解除対象', () => {
  const tabs = [{ id: 1, url: 'https://a.com/1', groupId: 10 }];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'a.com': true });
  assert.deepEqual(toGroup, []);
  assert.deepEqual(toUngroup, [1]);
});

test('planWindowActions: OFFかつグループ中のタブは解除対象', () => {
  const tabs = [
    { id: 1, url: 'https://a.com/1', groupId: 10 },
    { id: 2, url: 'https://a.com/2', groupId: 10 },
  ];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'a.com': false });
  assert.deepEqual(toGroup, []);
  assert.deepEqual(toUngroup, [1, 2]);
});

test('planWindowActions: OFFでグループに属していないタブは解除しない', () => {
  const tabs = [
    { id: 1, url: 'https://a.com/1', groupId: -1 },
    { id: 2, url: 'https://a.com/2', groupId: -1 },
  ];
  const { toUngroup } = planWindowActions(tabs, {});
  assert.deepEqual(toUngroup, []);
});

test('planWindowActions: LOCAL_FILES_GROUP はトグルに関係なく2タブ以上でグループ化', () => {
  const tabs = [
    { id: 1, url: 'file:///a.html', groupId: -1 },
    { id: 2, url: 'file:///b.html', groupId: -1 },
  ];
  const { toGroup } = planWindowActions(tabs, {});
  assert.deepEqual(toGroup, [{ domain: LOCAL_FILES_GROUP, tabIds: [1, 2] }]);
});

test('planWindowActions: LOCAL_FILES_GROUP も1タブに減ったら解除対象', () => {
  const tabs = [{ id: 1, url: 'file:///a.html', groupId: 10 }];
  const { toGroup, toUngroup } = planWindowActions(tabs, {});
  assert.deepEqual(toGroup, []);
  assert.deepEqual(toUngroup, [1]);
});

test('planWindowActions: 無効なURLのタブは無視する', () => {
  const tabs = [
    { id: 1, url: 'chrome://settings', groupId: -1 },
    { id: 2, url: 'https://a.com/1', groupId: 10 },
    { id: 3, url: 'https://a.com/2', groupId: 10 },
  ];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'a.com': true });
  assert.deepEqual(toGroup, [{ domain: 'a.com', tabIds: [2, 3] }]);
  assert.deepEqual(toUngroup, []);
});

test('planWindowActions: 混在ケース（ON解除なし・OFF解除あり）', () => {
  const tabs = [
    { id: 1, url: 'https://on.com/1', groupId: -1 },
    { id: 2, url: 'https://on.com/2', groupId: -1 },
    { id: 3, url: 'https://off.com/1', groupId: 20 },
    { id: 4, url: 'https://off.com/2', groupId: 20 },
  ];
  const { toGroup, toUngroup } = planWindowActions(tabs, { 'on.com': true });
  assert.deepEqual(toGroup, [{ domain: 'on.com', tabIds: [1, 2] }]);
  assert.deepEqual(toUngroup, [3, 4]);
});

// --- pickColor -------------------------------------------------------------

test('pickColor: 未使用の色を優先して返す', () => {
  const used = ['grey', 'blue'];
  const color = pickColor(used, () => 0);
  assert.ok(!used.includes(color));
  assert.ok(COLORS.includes(color));
});

test('pickColor: 全色使用済みでも有効な色を返す', () => {
  const color = pickColor([...COLORS], () => 0);
  assert.ok(COLORS.includes(color));
});

// --- findDomainByGroupId ---------------------------------------------------

test('findDomainByGroupId: グループIDからドメインを逆引きする', () => {
  const winState = {
    'a.com': { id: 10, color: 'blue', collapsed: false },
    'b.com': { id: 20, color: 'red', collapsed: true },
  };
  assert.equal(findDomainByGroupId(winState, 20), 'b.com');
  assert.equal(findDomainByGroupId(winState, 99), null);
});

// --- groupTitleFor ---------------------------------------------------------

test('groupTitleFor: ドメインはそのまま、ローカルファイルは専用表記', () => {
  assert.equal(groupTitleFor('a.com'), 'a.com');
  assert.equal(groupTitleFor(LOCAL_FILES_GROUP), '📁 Local Files');
});

// --- findReusableGroup -----------------------------------------------------

test('findReusableGroup: 同じタイトルの既存グループを返す', () => {
  const groups = [
    { id: 10, title: 'b.com' },
    { id: 20, title: 'a.com' },
  ];
  const tabs = [{ id: 1, groupId: -1 }];
  assert.equal(findReusableGroup(groups, 'a.com', tabs)?.id, 20);
});

test('findReusableGroup: 該当タイトルがなければnull', () => {
  const groups = [{ id: 10, title: 'b.com' }];
  assert.equal(findReusableGroup(groups, 'a.com', []), null);
});

test('findReusableGroup: 同名が複数あれば対象タブを最も多く含むものを返す', () => {
  const groups = [
    { id: 10, title: 'a.com' },
    { id: 20, title: 'a.com' },
  ];
  const tabs = [
    { id: 1, groupId: 20 },
    { id: 2, groupId: 20 },
    { id: 3, groupId: 10 },
  ];
  assert.equal(findReusableGroup(groups, 'a.com', tabs)?.id, 20);
});
