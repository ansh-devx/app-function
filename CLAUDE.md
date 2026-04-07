# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start local development (connects to Shopify, sets up tunnel)
npm run dev          # or: shopify app dev

# Build for production
npm run build

# Run linter
npm run lint

# Type checking
npm run typecheck

# Database setup (run first time or after schema changes)
npm run setup        # runs: prisma generate && prisma migrate deploy

# Deploy app to Shopify
npm run deploy
```

Node.js requirement: `>=20.19 <22 || >=22.12`

## Architecture

This is a **Shopify embedded app** built with React Router v7 and the `@shopify/shopify-app-react-router` package.

### Key files

- `app/shopify.server.js` — Shopify app singleton; exports `authenticate`, `login`, `sessionStorage`, etc. Import from here in all route loaders/actions. API version: `ApiVersion.October25`.
- `app/db.server.js` — Prisma client singleton (prevents connection exhaustion in dev HMR).
- `app/routes.js` — Uses `@react-router/fs-routes` flat routes convention.
- `prisma/schema.prisma` — SQLite by default; only a `Session` model for Shopify session storage.
- `shopify.app.toml` — App config: scopes, webhook subscriptions, redirect URLs.
- `extensions/discount-function/shopify.extension.toml` — Shopify Function extension config (handle: `discount-function`, target: `cart.lines.discounts.generate.run`, api_version: `2026-04`).
- `extensions/discount-function/src/cart_lines_discounts_generate_run.js` — Function logic for VIP discounts.

### Route conventions

Routes live in `app/routes/` using flat file naming:
- `app.jsx` — Layout route; authenticates all `/app/*` routes via `authenticate.admin(request)` and wraps with `<AppProvider>`.
- `app._index.jsx`, `app.additional.jsx` — App pages rendered inside the layout.
- `auth.$.jsx`, `auth.login/` — Shopify OAuth flow (handled by the package).
- `webhooks.app.uninstalled.jsx`, `webhooks.app.scopes_update.jsx` — Webhook handlers.

### VIP Discount feature routes

- `app/routes/app.discounts.jsx` — Layout parent (just renders `<Outlet />`).
- `app/routes/app.discounts._index.jsx` — List all VIP discounts.
- `app/routes/app.discounts.new.jsx` — Create a new discount (automatic or code).
- `app/routes/app.discounts.$id.jsx` — Edit/delete an existing discount. The `$id` param is a URL-encoded `DiscountCodeNode` or `DiscountAutomaticNode` GID.

### Authentication pattern

Every loader/action in app routes must call `authenticate.admin(request)` first:

```js
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  // admin.graphql(...) for Admin API calls
};
```

### UI components

The app uses **Polaris web components** (`<s-page>`, `<s-button>`, `<s-section>`, etc.) — not React Polaris components. These are custom elements from `@shopify/polaris-types`.

#### Known Polaris web component gotchas

- **`s-grid columns="2"` does not work** — use `<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>` instead.
- **`::slotted()` only matches direct children** — `s-section` elements inside a `<form>` inside a slotted slot get `margin-block-end: 0rem` instead of `1rem`. Fix: wrap them in `<s-stack direction="block" gap="base">`.
- **`e.currentTarget` is null inside React setState updaters** — always capture the value synchronously before calling setState:
  ```js
  onChange={(e) => { const checked = e.currentTarget.checked; setState(...); }}
  ```
- **`s-checkbox`** — use `checked` (not `defaultChecked`) + `onChange` for controlled usage.
- **`s-select`** — use `value` + `onChange` for controlled usage.
- **`s-number-field`** — use `defaultValue` for uncontrolled; supports `prefix`/`suffix` props.
- **`s-text-field`** — use `defaultValue` for uncontrolled or `value` + `onInput` for controlled.
- **`s-badge` tones** — `"success"`, `"caution"`, `"neutral"`, `"critical"`.
- **`s-page` aside slot** — place `<s-section slot="aside">` outside the `<form>` tag.

### Navigation

- Use `<s-link>` or `Link` from `react-router`, never `<a>` tags (breaks embedded app sessions).
- Use `redirect` from `react-router` (not from `authenticate.admin`) in action returns.

### Webhooks

Webhooks are declared in `shopify.app.toml` (app-specific) and synced on `deploy`. Do not use `registerWebhooks` in `afterAuth` for app-wide webhooks.

### Extensions

Extensions live in `extensions/`. The VIP discount function is at `extensions/discount-function/`.

---

## Shopify Admin GraphQL — Critical Notes

### Use `discountNodes`, NOT `codeDiscountNodes` / `automaticDiscountNodes`

`codeDiscountNodes` and `automaticDiscountNodes` are **deprecated** and do **not** return `DiscountCodeApp` / `DiscountAutomaticApp` type discounts (app function discounts). Always use:

```graphql
discountNodes(first: 250, query: "type:app") {
  nodes {
    id
    discount {
      __typename
      ... on DiscountAutomaticApp { discountId title status startsAt endsAt }
      ... on DiscountCodeApp {
        discountId title status startsAt endsAt
        codes(first: 1) { nodes { code } }
      }
    }
    metafield(namespace: "$app:discount-function", key: "config") { value }
  }
}
```

- `DiscountNode.id` is the `gid://shopify/DiscountNode/...` ID (use for `discountNode` singular query).
- `discount.discountId` is the `gid://shopify/DiscountCodeNode/...` or `gid://shopify/DiscountAutomaticNode/...` ID — use this for **edit** (`codeDiscountNode(id:)`, `discountAutomaticAppUpdate`) and **delete** (`discountCodeDelete`, `discountAutomaticDelete`) operations.

### API version (2025-10 vs 2026-04)

- App admin client uses `ApiVersion.October25` (`2025-10`).
- Extension TOML uses `api_version = "2026-04"`.
- In `2025-10`, `DiscountCodeAppInput.code` is a **single string** (not `codes: [{ code }]` array — that was removed).

### Creating discounts

```graphql
# Code discount
mutation CreateCodeDiscount($discount: DiscountCodeAppInput!) {
  discountCodeAppCreate(codeAppDiscount: $discount) {
    codeAppDiscount { discountId title }
    userErrors { field message }
  }
}

# Automatic discount
mutation CreateAutomaticDiscount($discount: DiscountAutomaticAppInput!) {
  discountAutomaticAppCreate(automaticAppDiscount: $discount) {
    automaticAppDiscount { discountId title }
    userErrors { field message }
  }
}
```

Input shape:
```js
{
  title,
  functionHandle: "discount-function",  // must match handle in shopify.extension.toml
  startsAt,                              // ISO string
  endsAt,                                // ISO string or omit (not null)
  combinesWith: { orderDiscounts, productDiscounts, shippingDiscounts },
  metafields: [{ namespace: "$app:discount-function", key: "config", type: "json", value: JSON.stringify(config) }],
  // code discount only:
  code: "DISCOUNT_CODE",                 // single string, not array
}
```

### Metafield config schema

Stored at namespace `$app:discount-function`, key `config`, type `json`:
```json
{
  "customerTags": ["VIP", "GOLD"],
  "productIds": ["gid://shopify/Product/123"],
  "collectionIds": ["gid://shopify/Collection/456"],
  "discountPercentage": 20,
  "discountType": "percentage",          // "percentage" | "fixed"
  "discountMethod": "code"               // "code" | "automatic"
}
```

### Deleting discounts

Determine type from ID, then call the correct mutation:
```js
const isCode = id.includes("DiscountCodeNode");
// isCode  → discountCodeDelete(id: $id)
// !isCode → discountAutomaticDelete(id: $id)
```

### Editing discounts

Loader fetches via `codeDiscountNode(id:)` or `automaticDiscountNode(id:)` (singular, by `discountId`).
Update via `discountCodeAppUpdate` / `discountAutomaticAppUpdate`. The discount code itself **cannot be changed** after creation (Shopify limitation).

---

## VIP Discount Function

**File:** `extensions/discount-function/src/cart_lines_discounts_generate_run.js`

- Reads config from metafield at `$app:discount-function / config`.
- Checks if any cart `buyerIdentity.customer.hasTags` matches `config.customerTags`.
- Filters cart lines to those whose `product.id` is in `config.productIds`.
- Returns `percentage` or `fixedAmount` discount based on `config.discountType`.
- Uses `ProductDiscountSelectionStrategy.First`.

The function has two targets in the TOML:
1. `cart.lines.discounts.generate.run` — product line discounts (main logic).
2. `cart.delivery-options.discounts.generate.run` — shipping discounts (separate file).
