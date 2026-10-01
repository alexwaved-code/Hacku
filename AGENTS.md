# Hacku — four groups

Read `COLLAB.md` before you touch code.

You are one of four Cursor agents sharing this GitHub repo. There is no live agent-to-agent chat. GitHub is the bus.

- Write only your group's files. Never edit another group's `status.md` or `outbox.md`.
- Group id is local `collab/.agent-id` (gitignored): `G1` / `G2` / `G3` / `G4`. If it is missing, ask the human.
- You own `collab/gN/**` plus the paths listed for your group in `collab/groups.md`.
- Shared paths need an outbox `ACK` from the groups that will be affected, then one edit.

Session start: `git checkout` your branch (`g1`–`g4`), `git pull --rebase origin main`, read the other three outboxes, update yours, then work. Commit prefix `[G1]` / `[G2]` / `[G3]` / `[G4]`. Push your branch. Do not push `main`. No force-push.

Do not invent a live socket or chat app between agents.
