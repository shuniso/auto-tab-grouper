#!/usr/bin/env bash
# 配布用 zip を dist/ に作成し、そのパスを標準出力に出す（ローカル・CI 共通）。
# 使い方: scripts/package.sh [期待するバージョン]
#   期待するバージョンを渡すと manifest.json と一致するか検証する（リリース時のタグ照合用）。
set -euo pipefail
cd "$(dirname "$0")/.."

# 拡張機能の実行に必要なファイルだけを同梱する（テスト・開発用ファイルは含めない）。
# 実行時に読み込むファイルを追加した場合はここにも追加する。
FILES=(manifest.json background.js logic.js popup.html popup.js LICENSE)

manifest_version=$(node -p "require('./manifest.json').version")
package_version=$(node -p "require('./package.json').version")

if [ "$manifest_version" != "$package_version" ]; then
  echo "error: manifest.json ($manifest_version) と package.json ($package_version) のバージョンが一致しません" >&2
  exit 1
fi

if [ $# -ge 1 ] && [ "$1" != "$manifest_version" ]; then
  echo "error: 指定バージョン ($1) と manifest.json ($manifest_version) が一致しません" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "error: 同梱ファイルが見つかりません: $f" >&2
    exit 1
  fi
done

out="dist/auto-tab-grouper-${manifest_version}.zip"
mkdir -p dist
rm -f "$out"
# manifest.json を zip のルートに置く（Chrome ウェブストアの要件）。-X で OS 固有の属性を除く
zip -q -X "$out" "${FILES[@]}"
echo "$out"
