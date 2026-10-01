# Groups

Fill names and folders before anyone writes product code. One path tree per group. No overlap.

Integrator: `alexwaved-code` (merges `g1`–`g4` into `main`).

| Group | Branch | Humans | Owns | Do not touch |
|---|---|---|---|---|
| G1 | `g1` | | | other `collab/gN/**` |
| G2 | `g2` | | | other `collab/gN/**` |
| G3 | `g3` | | | other `collab/gN/**` |
| G4 | `g4` | | | other `collab/gN/**` |

## Shared (ACK first)

These need an outbox plan and ACK from every group that will be affected:

- `COLLAB.md`
- `AGENTS.md`
- `README.md`
- `collab/groups.md`
- lockfiles and package manifests
- any path listed here later

Until a group owns a folder in the table, do not create product directories.
