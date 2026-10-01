# Hacku

四組人共用這一個 GitHub repo。GitHub 是唯一的工作黑板。Agent 不另外開聊天室。

## 第一次（每人一次）

1. 跟 repo 負責人要邀請，加入 `alexwaved-code/Hacku`。
2. Clone：

```bash
git clone https://github.com/alexwaved-code/Hacku.git
cd Hacku
```

3. 在 `collab/groups.md` 找到自己的組（G1–G4）。
4. 本機寫入組別（這個檔不會進 git）：

```bash
echo G1 > collab/.agent-id
```

把 `G1` 換成你的組。

## 之後每次開工

```bash
git checkout g1
git pull --rebase origin main
```

只改自己組擁有的路徑。做完一段能跑的東西：

```bash
git add …
git commit -m "[G1] 簡短說明為什麼改"
git pull --rebase origin main
git push -u origin g1
```

把 `g1` / `[G1]` 換成自己的組。

## 誰進 main

只有整合者把 `g1`–`g4` 合進 `main`。其他人不要直接 push `main`。不要 force-push。

完整規則見 [COLLAB.md](COLLAB.md)。組別與目錄見 [collab/groups.md](collab/groups.md)。
