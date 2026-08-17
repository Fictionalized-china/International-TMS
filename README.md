# International TMS

国际零担运输管理系统。当前基础版本包含运营后台、客户门户、基础数据、客户与销售管理以及权限安全。

## Sites

- Operations: `/admin`, prepared for `admin.oulingtruck.com`
- Customer portal: `/portal`, prepared for `portal.oulingtruck.com`
- Warehouse operations: `/warehouse`, prepared for `warehouse.oulingtruck.com`
- The sites share one organization-scoped D1 database but enforce separate session types, layouts and authorization boundaries.

Production domain plan:

- `oulingtruck.com`: public website or unified entry
- `admin.oulingtruck.com`: operations and management
- `portal.oulingtruck.com`: customer self-service
- `warehouse.oulingtruck.com`: warehouse and field operations

Each hostname should be attached to the same Worker as a separate Cloudflare Custom Domain. Sessions are host-only cookies and carry a server-side site type, so credentials issued on one site cannot authorize another site. Warehouse users additionally require `warehouse.view`; operating and configuration actions use `warehouse.operate` and `warehouse.manage`.

## Current modules

- Cloudflare Workers + React Router + TypeScript
- Cloudflare D1 schema and versioned migrations
- One-time protected system bootstrap
- Organization-level tenant isolation
- Secure password hashing and server-side sessions
- Users, memberships, roles and fine-grained permissions
- Reference data for countries, currencies, units, transport modes, service levels and lead sources
- Customer 360 records, contacts, addresses, credit terms and customer portal accounts
- Sales leads, opportunities, pipeline stages and activities
- Quotations with routes, cargo metrics, charge lines, tax and customer acceptance
- Transport orders from the operations site or customer portal
- Shipments, carriers, transport legs, customer-visible tracking events and proof of delivery
- Accounts receivable invoices, charge lines, due dates and payment status
- Separate operations and customer portal authentication
- Separate warehouse login, permissions and operations shell
- Login lockout, session monitoring and session revocation
- Security audit trail
- Pull-request CI and protected automatic production deployment from `main`

## Phase-one workflow

`Customer → Opportunity → Quotation → Transport order → Shipment → Delivery → Invoice`

Each workflow uses guarded status transitions, organization-scoped authorization,
automatic document numbering and audit events. Customer portal users can accept or
reject quotations, submit bookings, follow shipment tracking and review issued invoices.

## Local setup

Requirements: Node.js 22 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Set a long random `BOOTSTRAP_TOKEN` in `.dev.vars`. Open `/setup` once to create the
first organization and owner. The setup route disables itself after the first user
exists.

## Verification

```bash
npm run ci
```

This runs generated Cloudflare types, React Router route types, TypeScript checks,
unit tests, and a production build.

## Production deployment

Merges to `main` automatically run validation, D1 migrations and the Cloudflare
Workers deployment through the protected GitHub `production` environment.

The workflow can also be started manually through **Deploy production**. Bind the
future custom domains to the same Worker; hostname routing already recognizes
`admin.oulingtruck.com`, `portal.oulingtruck.com` and `warehouse.oulingtruck.com`.

Never commit `.dev.vars`, `.env`, tokens, passwords, keys, or customer data.
