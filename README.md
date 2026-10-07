# THE LAB (FACETS)

Built by `exp/site_draft/build_deploy.cjs`. Do not edit here: edit `exp/site_draft` and rebuild.

## Run
`npm install && npm start` (PORT defaults to 8140).

## Railway variables
- `RPC_URL`: mainnet RPC with the key. Required. Never committed.
- `ART_DIR=/data/art`: art cache on the volume mounted at `/data` (sales.json lands in `/data`).

## What it serves
The page, plus `/api/*` (health, collection, discover, traits, dashboard, activity, wallet/<addr>, token/<id>, art/<id>.svg).
