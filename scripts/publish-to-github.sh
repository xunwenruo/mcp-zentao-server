#!/usr/bin/env bash
# 把当前 SOURCE_BRANCH 的工作树作为「单一提交」摞在 REMOTE/TARGET_BRANCH 之上推送，
# 让 GitHub 远端只看到 init + 一系列摞上去的整合提交，本地的内部开发历史不外溢。
#
# 用法:
#   scripts/publish-to-github.sh                    # 用 main 的最新 commit message 作为提交说明
#   scripts/publish-to-github.sh -m "feat: xxx"     # 自定义提交说明
#   scripts/publish-to-github.sh --dry-run          # 走完整流程但不真正 push
#   PUBLISH_SCAN_EXTRA='secret_xx|company\.com' \
#     scripts/publish-to-github.sh                  # 额外敏感正则
#
# 环境变量:
#   REMOTE          (default: github)
#   SOURCE_BRANCH   (default: main)        — 取该分支的工作树作为发布内容
#   TARGET_BRANCH   (default: main)        — 推到远端的哪个分支
#   PUBLISH_SCAN_EXTRA                     — 额外敏感正则（| 分隔）

set -euo pipefail

REMOTE="${REMOTE:-github}"
SOURCE_BRANCH="${SOURCE_BRANCH:-main}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
MSG=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)         MSG="$2"; shift 2;;
    --dry-run)            DRY_RUN=1; shift;;
    --remote)             REMOTE="$2"; shift 2;;
    --source-branch)      SOURCE_BRANCH="$2"; shift 2;;
    --target-branch)      TARGET_BRANCH="$2"; shift 2;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

err()  { printf "❌ %s\n" "$*" >&2; exit 1; }
info() { printf "→ %s\n" "$*"; }

# ---------- 前置检查 ----------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || err "当前目录不是 git 仓库"

if ! git diff --quiet || ! git diff --cached --quiet; then
  err "工作树不干净，请先提交/暂存你的本地改动再发布"
fi

git remote get-url "$REMOTE" >/dev/null 2>&1 \
  || err "remote '$REMOTE' 不存在。先运行: git remote add $REMOTE <url>"

git rev-parse --verify "$SOURCE_BRANCH" >/dev/null 2>&1 \
  || err "本地分支 '$SOURCE_BRANCH' 不存在"

# ---------- 拉取远端最新 ----------
info "git fetch $REMOTE $TARGET_BRANCH"
git fetch "$REMOTE" "$TARGET_BRANCH"

CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TMP_BRANCH="publish-$(date +%Y%m%d%H%M%S)"
cleanup() {
  # 恢复到原分支，删临时分支；失败也不阻断
  git checkout -f "$CUR_BRANCH" >/dev/null 2>&1 || true
  git branch -D "$TMP_BRANCH"   >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------- 在 REMOTE/TARGET_BRANCH 上建临时分支，把 SOURCE_BRANCH 的整棵 tree 装进 index ----------
git checkout -b "$TMP_BRANCH" "$REMOTE/$TARGET_BRANCH" >/dev/null
# read-tree --reset: 让 index 与工作树等于 SOURCE_BRANCH 的 tree（含删除），HEAD 仍在临时分支
git read-tree -u --reset "$SOURCE_BRANCH"

# 没有任何差异 → 远端已是最新
if git diff --cached --quiet; then
  info "远端已经是最新，无需推送"
  exit 0
fi

# ---------- 展示与扫描 ----------
echo
echo "=== 即将提交到 $REMOTE/$TARGET_BRANCH 的差异 ==="
git diff --cached --stat

# 默认敏感正则：内网 IP、私钥块、常见明文 secret 写法
SCAN_RE='172\.16\.|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|password[[:space:]]*[:=][[:space:]]*["\x27][^"\x27]{6,}'
[[ -n "${PUBLISH_SCAN_EXTRA:-}" ]] && SCAN_RE="$SCAN_RE|$PUBLISH_SCAN_EXTRA"

# 扫描 staged diff，去掉 env 名引用 / 占位 / 示例 的常见噪声
HITS=$(git diff --cached -- . \
  | grep -nEi "$SCAN_RE" \
  | grep -vE 'process\.env|\.env\.example|placeholder|占位|示例|your-|<.*>' \
  || true)
if [[ -n "$HITS" ]]; then
  echo
  echo "⚠️  在 staged diff 中发现可疑模式（请人工确认无敏感）："
  echo "$HITS" | head -30
  read -rp "继续推送? (y/N): " ans
  [[ "$ans" =~ ^[yY]$ ]] || err "已取消"
fi

# .env 出现在 staged 立即中止（按 .gitignore 不该出现，双保险）
if git diff --cached --name-only | grep -Eq '^(\.env|.*/\.env)$'; then
  err ".env 进入了暂存区，已中止（请检查 .gitignore）"
fi

# ---------- 提交 ----------
[[ -z "$MSG" ]] && MSG="$(git log -1 --pretty=%s "$SOURCE_BRANCH")"
git commit -m "$MSG" >/dev/null
SHA="$(git rev-parse --short HEAD)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  info "DRY RUN: 不真正推送。本应执行: git push $REMOTE $TMP_BRANCH:$TARGET_BRANCH"
  git log -1 --stat | head -25
  exit 0
fi

# ---------- 推送 ----------
info "git push $REMOTE $TMP_BRANCH:$TARGET_BRANCH"
git push "$REMOTE" "$TMP_BRANCH:$TARGET_BRANCH"

echo
echo "✅ 已发布到 $REMOTE/$TARGET_BRANCH： $SHA $MSG"
