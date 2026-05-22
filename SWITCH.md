# Using Comunica (5.2.2) in Colab-Research

This tree (`comunica/`) is the **canonical** Comunica (`itsRekas/comunica`) with the Colab vector query source and `comunica-vector` CLI.

## Repository layout

| Path | Role |
| ---- | ---- |
| `comunica/` | Comunica **5.2.2** — vector source, `comunica-vector`, SPARQL tweaks |
| `vector-endpoint/` | Milvus + Flask API (`/vector`, `/sparql`) on port 2222 |

## Build

```bash
cd comunica
yarn install
yarn build
yarn run build:engines
```

## Install CLIs on PATH

```bash
cd engines/query-sparql && yarn link
cd ../query-sparql-file && yarn link
```

## Run vector queries

With **vector-endpoint** on port 2222:

```bash
comunica-vector http://localhost:2222/vector -k 10 -q 'SELECT ?s WHERE { ?s <http://example.org/occupation> "Software Engineer" }'
```

See `query.txt` for small example.org demos (not in the RLUBM vector index). Use **`query-lubm.txt`** for dim=8 LUBM smoke queries against `version_5`. `RLUBM_cleaned.nt` is used with `comunica-sparql-file` in benchmarks.

### Milvus / vector-endpoint

Collection `version_5` must be loaded (embedding dim **24** = 3×8):

```bash
cd vector-endpoint
.venv/bin/python scripts/check_milvus_collection.py
# if empty:
.venv/bin/python src/load.py data/nts/RLUBM_cleaned.nt \
  --collection version_5 --target-embedding-dim 8 --catalog-out catalog.pkl --log
```
