# 協作規則

四組人、各自的 Cursor agent，共用這一個 repo。沒有 agent 對 agent 的即時聊天。GitHub 就是匯流排。

## 組別

| 組 | 分支 | 本機標記 | 自己的留言板 |
|---|---|---|---|
| G1 | `g1` | `collab/.agent-id` 寫 `G1` | `collab/g1/` |
| G2 | `g2` | `G2` | `collab/g2/` |
| G3 | `g3` | `G3` | `collab/g3/` |
| G4 | `g4` | `G4` | `collab/g4/` |

程式目錄寫在 `collab/groups.md`。沒寫進該表的路徑，不要先建、不要先改。

整合者：`alexwaved-code`。只由整合者把各組分支合進 `main`。

## 每次開工

1. `git checkout` 自己的分支，再 `git pull --rebase origin main`。
2. 讀 `COLLAB.md`、`collab/groups.md`、`collab/tasks.md`，以及**其他三組**的 `status.md` 與 `outbox.md`。
3. 只在自己的 outbox 回覆。只更新自己的 status。
4. 只改自己擁有的路徑。
5. Commit 前綴 `[G1]` / `[G2]` / `[G3]` / `[G4]`，push 到自己的分支。

不知道自己是哪一組，先問人，再寫 `collab/.agent-id`。

## 地盤

- 只改 `groups.md` 裡自己那一列的路徑，加上 `collab/gN/**`。
- 不要改其他組的程式或留言板。
- 共用檔（`COLLAB.md`、`AGENTS.md`、`README.md`、鎖檔、以及 `groups.md` 列為 shared 的路徑）：先在自己的 outbox 寫計畫，等其他會被影響的組在 outbox 回 `ACK`，再改。
- 不要在聊天裡「講好」卻不改 repo。Repo 才算數。

## 留言格式

寫在自己的 `collab/gN/outbox.md` 最上面：

```md
## 2026-10-02 10:00 — to G2

NEED: 請匯出 `getCityColliders()`（世界座標 Box3 清單）
BLOCKED: 碰撞還接不上
ACK: 收到 `terrainType`，會沿用
KEEP: 不要改這個 export 名稱
NOTE: spawn 維持 `SPAWN` 常數
```

一次一則為主。人用微信；agent 只寫這裡。

`status.md` 只寫：`doing` / `done` / `blocked` / `next` / `ask_other`。

任務列在 `collab/tasks.md`。只改自己組的列。

## Git

- 先 clone 一次。之後用 pull / push。沒有本地副本就沒有 pull。
- 在自己的分支上工作。不要直接 push `main`。
- 不要 force-push。不要改 git config。
- Push 之前再 `git pull --rebase origin main` 一次。
- 不要 commit `.env`、金鑰、`node_modules`、`dist`。

## 整合者

```bash
git checkout main
git pull --rebase origin main
git merge origin/g1
git push origin main
```

一次合一個分支。衝突只動該組的檔；共用檔有爭議就退回，等 outbox ACK。

## 不要

- 自幹 agent 即時聊天、socket、或「給 agent 用的 WhatsApp」。
- 四組同時改同一個檔。
- 用聊天紀錄當契約。契約寫在 repo。
