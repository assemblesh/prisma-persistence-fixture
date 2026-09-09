# Assemble Postgres persistence fixture

This is a small Node 22 service for proving that an application can write a
run-scoped value to Postgres, be redeployed, and read the value back. It has no
Dockerfile; Assembler detects `package-lock.json` and the `start` script and
generates the runtime recipe.

The service reads `DATABASE_URL`, `RUN_KEY`, and optional `PORT` at runtime.
`DATABASE_URL` and `RUN_KEY` should be delivered as service-scoped runtime
secrets. The application role only needs `SELECT` and `INSERT` on the table;
apply `schema.sql` with a migration owner before starting the app.

```sh
npm ci
npm test
DATABASE_URL='postgres://...' RUN_KEY='per-run-secret' npm start
```

`GET /healthz` is public. `POST /records` and `GET /records/:id` require the
`X-Run-Key` header. A record id is limited to 128 safe identifier characters;
the value is limited to 512 UTF-8 bytes. SQL uses parameters throughout.
