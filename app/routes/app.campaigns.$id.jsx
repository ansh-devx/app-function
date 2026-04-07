import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError, useNavigate } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const GET_AUTO_UNIFIED = `#graphql
  query GetAutoUnified($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        ... on DiscountAutomaticApp {
          title status startsAt endsAt
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
      volumeMeta: metafield(namespace: "$app:volume-campaigns", key: "config") { value }
      vipMeta: metafield(namespace: "$app:discount-function", key: "config") { value }
    }
  }
`;

const GET_CODE_VIP = `#graphql
  query GetCodeVip($id: ID!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount {
        ... on DiscountCodeApp {
          title status startsAt endsAt
          codes(first: 1) { nodes { code } }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
      metafield(namespace: "$app:discount-function", key: "config") { value }
    }
  }
`;

const GET_PRODUCTS_BY_IDS = `#graphql
  query GetProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Product { id title } }
  }
`;

const GET_COLLECTIONS_BY_IDS = `#graphql
  query GetCollectionsByIds($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Collection { id title } }
  }
`;

const GET_COLLECTION_PRODUCTS = `#graphql
  query GetCollectionProducts($id: ID!) {
    collection(id: $id) { products(first: 250) { nodes { id } } }
  }
`;

const UPDATE_AUTO = `#graphql
  mutation UpdateAuto($id: ID!, $discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const UPDATE_CODE = `#graphql
  mutation UpdateCode($id: ID!, $discount: DiscountCodeAppInput!) {
    discountCodeAppUpdate(id: $id, codeAppDiscount: $discount) {
      codeAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const DELETE_AUTO = `#graphql
  mutation DeleteAuto($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

const DELETE_CODE = `#graphql
  mutation DeleteCode($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }
`;

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = decodeURIComponent(params.id);
  const isCode = id.includes("DiscountCodeNode");

  let type, title, status, startsAt, endsAt, combinesWithData, config = {}, discountCode = null;

  if (isCode) {
    const res = await admin.graphql(GET_CODE_VIP, { variables: { id } });
    const { data } = await res.json();
    const node = data?.codeDiscountNode;
    if (!node) throw new Response("Campaign not found", { status: 404 });
    const d = node.codeDiscount;
    type = "vip";
    title = d?.title ?? "";
    status = d?.status ?? "UNKNOWN";
    startsAt = d?.startsAt ?? "";
    endsAt = d?.endsAt ?? "";
    combinesWithData = d?.combinesWith ?? {};
    discountCode = d?.codes?.nodes?.[0]?.code ?? "";
    try { config = JSON.parse(node.metafield?.value ?? "{}"); } catch {}
  } else {
    const res = await admin.graphql(GET_AUTO_UNIFIED, { variables: { id } });
    const { data } = await res.json();
    const node = data?.automaticDiscountNode;
    if (!node) throw new Response("Campaign not found", { status: 404 });
    const d = node.automaticDiscount;
    title = d?.title ?? "";
    status = d?.status ?? "UNKNOWN";
    startsAt = d?.startsAt ?? "";
    endsAt = d?.endsAt ?? "";
    combinesWithData = d?.combinesWith ?? {};
    if (node.volumeMeta) {
      type = "volume";
      try { config = JSON.parse(node.volumeMeta.value); } catch {}
    } else if (node.vipMeta) {
      type = "vip";
      try { config = JSON.parse(node.vipMeta.value); } catch {}
    } else {
      throw new Response("Campaign not found", { status: 404 });
    }
  }

  const productIds = config.productIds ?? [];
  const collectionIds = config.collectionIds ?? [];

  let products = [];
  if (productIds.length > 0) {
    const pRes = await admin.graphql(GET_PRODUCTS_BY_IDS, { variables: { ids: productIds.slice(0, 50) } });
    const pData = await pRes.json();
    products = (pData.data?.nodes ?? []).filter(Boolean).map((p) => ({ id: p.id, title: p.title }));
  }

  let collections = [];
  if (collectionIds.length > 0) {
    const cRes = await admin.graphql(GET_COLLECTIONS_BY_IDS, { variables: { ids: collectionIds } });
    const cData = await cRes.json();
    collections = (cData.data?.nodes ?? []).filter(Boolean).map((c) => ({ id: c.id, title: c.title }));
  }

  const displayMode = collectionIds.length > 0 ? "collections" : (productIds.length > 0 ? "products" : (type === "vip" ? "all" : "products"));

  return {
    id, type, title, status, startsAt, endsAt, discountCode,
    combinesWith: {
      shippingDiscounts: combinesWithData.shippingDiscounts ?? false,
      orderDiscounts: combinesWithData.orderDiscounts ?? false,
      productDiscounts: combinesWithData.productDiscounts ?? false,
    },
    // Volume fields
    tiers: config.tiers ?? [],
    products, collections, displayMode,
    // VIP fields
    customerTags: (config.customerTags ?? []).join(", "),
    discountPercentage: config.discountPercentage ?? "",
    discountType: config.discountType ?? "percentage",
    discountMethod: isCode ? "code" : (config.discountMethod ?? "automatic"),
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = decodeURIComponent(params.id);
  const form = await request.formData();
  const intent = form.get("intent");
  const campaignType = form.get("campaignType");
  const isCode = id.includes("DiscountCodeNode");

  if (intent === "update") {
    const title = form.get("title");
    const directProductIds = JSON.parse(form.get("productIds") ?? "[]");
    const collectionIds = JSON.parse(form.get("collectionIds") ?? "[]");
    const combinesWith = {
      orderDiscounts: form.get("combinesWithOrder") === "true",
      productDiscounts: form.get("combinesWithProduct") === "true",
      shippingDiscounts: form.get("combinesWithShipping") === "true",
    };

    let allProductIds = [...directProductIds];
    for (const collId of collectionIds) {
      const res = await admin.graphql(GET_COLLECTION_PRODUCTS, { variables: { id: collId } });
      const { data } = await res.json();
      (data?.collection?.products?.nodes ?? []).forEach(({ id: pid }) => {
        if (!allProductIds.includes(pid)) allProductIds.push(pid);
      });
    }

    const startsAt = form.get("startsAt") ? new Date(form.get("startsAt")).toISOString() : new Date().toISOString();
    const endsAtRaw = form.get("endsAt");
    const endsAt = endsAtRaw ? new Date(endsAtRaw).toISOString() : null;

    let metafields, mutation, dataKey;

    if (campaignType === "volume") {
      const tiers = JSON.parse(form.get("tiers") ?? "[]");
      const config = JSON.stringify({ productIds: allProductIds, collectionIds, tiers });
      metafields = [{ namespace: "$app:volume-campaigns", key: "config", type: "json", value: config }];
      mutation = UPDATE_AUTO;
      dataKey = "discountAutomaticAppUpdate";
    } else {
      const tagsRaw = form.get("customerTags") ?? "";
      const customerTags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const discountPercentage = Number(form.get("discountPercentage"));
      const discountType = form.get("discountType") ?? "percentage";
      const discountMethod = isCode ? "code" : "automatic";
      const config = JSON.stringify({ customerTags, productIds: allProductIds, discountPercentage, discountType, collectionIds, discountMethod });
      metafields = [{ namespace: "$app:discount-function", key: "config", type: "json", value: config }];
      mutation = isCode ? UPDATE_CODE : UPDATE_AUTO;
      dataKey = isCode ? "discountCodeAppUpdate" : "discountAutomaticAppUpdate";
    }

    const baseInput = { title, startsAt, ...(endsAt ? { endsAt } : {}), combinesWith, metafields };
    const res = await admin.graphql(mutation, { variables: { id, discount: baseInput } });
    const { data } = await res.json();
    const errors = data?.[dataKey]?.userErrors;
    if (errors?.length) return { errors };
    return redirect("/app/campaigns");
  }

  if (intent === "delete") {
    const res = await admin.graphql(isCode ? DELETE_CODE : DELETE_AUTO, { variables: { id } });
    const { data } = await res.json();
    const errors = isCode
      ? (data?.discountCodeDelete?.userErrors ?? [])
      : (data?.discountAutomaticDelete?.userErrors ?? []);
    if (errors?.length) return { errors };
    return redirect("/app/campaigns");
  }

  return null;
};

// ─── Shared UI helpers ────────────────────────────────────────────────────────

const resourceRowStyle = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 14px", border: "1px solid #E1E3E5", borderRadius: "8px", background: "#FAFBFB",
};

const COMBINES_WITH_OPTIONS = [
  { key: "shippingDiscounts", label: "Shipping discounts" },
  { key: "orderDiscounts", label: "Order discounts" },
  { key: "productDiscounts", label: "Other product discounts" },
];

const STATUS_TONES = { ACTIVE: "success", SCHEDULED: "caution", EXPIRED: "neutral", PAUSED: "caution", UNKNOWN: "neutral" };
const STATUS_LABELS = { ACTIVE: "Active", SCHEDULED: "Scheduled", EXPIRED: "Expired", PAUSED: "Paused", UNKNOWN: "Unknown" };
const toDateOnly = (iso) => (iso ? iso.slice(0, 10) : "");

function TierRow({ tier, index, onChange, onRemove, canRemove }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "12px" }}>
      <div style={{ flex: 1 }}>
        <s-number-field label={index === 0 ? "Quantity" : undefined}
          value={String(tier.quantity)} min={1} step={1} placeholder="e.g. 2"
          onInput={(e) => { const v = parseInt(e.currentTarget.value, 10); onChange({ ...tier, quantity: isNaN(v) ? "" : v }); }}
        />
      </div>
      <div style={{ flex: 1 }}>
        <s-number-field label={index === 0 ? "Total price (₹)" : undefined}
          value={String(tier.totalPrice)} min={0} step={1} placeholder="e.g. 699" prefix="₹"
          onInput={(e) => { const v = parseFloat(e.currentTarget.value); onChange({ ...tier, totalPrice: isNaN(v) ? "" : v }); }}
        />
      </div>
      {canRemove && <s-button variant="tertiary" onClick={onRemove}>Remove</s-button>}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EditCampaign() {
  const loaderData = useLoaderData();
  const updater = useFetcher({ key: "update-campaign" });
  const deleter = useFetcher({ key: "delete-campaign" });
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const isVip = loaderData.type === "vip";

  // Volume state
  const [selectedProducts, setSelectedProducts] = useState(loaderData.products);
  const [selectedCollections, setSelectedCollections] = useState(loaderData.collections);
  const [appliesToType, setAppliesToType] = useState(loaderData.displayMode);
  const [tiers, setTiers] = useState(loaderData.tiers.length > 0 ? loaderData.tiers : [{ quantity: "", totalPrice: "" }]);
  const [tierError, setTierError] = useState("");

  // VIP state
  const [discountType, setDiscountType] = useState(loaderData.discountType ?? "percentage");

  // Shared state
  const [combinesWith, setCombinesWith] = useState(loaderData.combinesWith);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const errors = updater.data?.errors ?? [];
  const isUpdating = updater.state !== "idle";
  const isDeleting = deleter.state !== "idle";

  useEffect(() => {
    const el = document.getElementById("campaign-save-bar");
    el?.show?.();
    return () => el?.hide?.();
  }, []);

  const handlePickProducts = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: selectedProducts.map((p) => ({ id: p.id })) });
    if (result) setSelectedProducts(result.map((p) => ({ id: p.id, title: p.title })));
  }, [shopify, selectedProducts]);

  const handlePickCollections = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "collection", multiple: true, selectionIds: selectedCollections.map((c) => ({ id: c.id })) });
    if (result) setSelectedCollections(result.map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount })));
  }, [shopify, selectedCollections]);

  const updateTier = (i, updated) => setTiers((prev) => prev.map((t, idx) => (idx === i ? updated : t)));
  const removeTier = (i) => setTiers((prev) => prev.filter((_, idx) => idx !== i));
  const addTier = () => setTiers((prev) => [...prev, { quantity: "", totalPrice: "" }]);

  const validateTiers = () => {
    if (tiers.length === 0) return "Add at least one tier.";
    const quantities = tiers.map((t) => Number(t.quantity));
    const prices = tiers.map((t) => Number(t.totalPrice));
    if (quantities.some((q) => !q || q < 1)) return "All quantities must be at least 1.";
    if (prices.some((p) => p === "" || p < 0)) return "All prices must be non-negative.";
    if (new Set(quantities).size !== quantities.length) return "Quantities must be unique.";
    const sorted = [...tiers].sort((a, b) => a.quantity - b.quantity);
    for (let i = 1; i < sorted.length; i++) {
      if (Number(sorted[i].totalPrice) <= Number(sorted[i - 1].totalPrice))
        return "Prices must increase as quantity increases.";
    }
    return "";
  };

  const handleSubmit = () => {
    if (!isVip) {
      const err = validateTiers();
      if (err) { setTierError(err); return; }
      setTierError("");
    }
    document.getElementById("campaign-save-bar")?.hide?.();
    const form = document.getElementById("edit-campaign-form");
    if (form) updater.submit(form, { method: "post" });
  };

  const tiersJson = JSON.stringify(tiers.map((t) => ({ quantity: Number(t.quantity), totalPrice: Number(t.totalPrice) })));
  const activeCombinations = COMBINES_WITH_OPTIONS.filter(({ key }) => combinesWith[key]).map(({ label }) => label);

  const targetStr = appliesToType === "products"
    ? (selectedProducts.length > 0 ? `${selectedProducts.length} product${selectedProducts.length !== 1 ? "s" : ""}` : "No products")
    : appliesToType === "collections"
      ? (selectedCollections.length > 0 ? `${selectedCollections.length} collection${selectedCollections.length !== 1 ? "s" : ""}` : "No collections")
      : "All products";

  const heading = isVip ? "Edit VIP Campaign" : "Edit Volume Campaign";

  return (
    <>
      <ui-save-bar id="campaign-save-bar">
        <button variant="primary" onClick={handleSubmit} disabled={isUpdating}>
          {isUpdating ? "Saving…" : "Save"}
        </button>
        <button onClick={() => { document.getElementById("campaign-save-bar")?.hide?.(); navigate("/app/campaigns"); }}>
          Discard
        </button>
      </ui-save-bar>

      <s-page heading={heading}>
        <s-button slot="primary-action" variant="destructive" onClick={() => setShowDeleteConfirm(true)}>
          Delete campaign
        </s-button>

        <updater.Form id="edit-campaign-form" method="post">
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="campaignType" value={loaderData.type} />
          <input type="hidden" name="productIds" value={JSON.stringify(
            appliesToType === "products" ? selectedProducts.map((p) => p.id) : []
          )} />
          <input type="hidden" name="collectionIds" value={JSON.stringify(
            appliesToType === "collections" ? selectedCollections.map((c) => c.id) : []
          )} />
          <input type="hidden" name="tiers" value={tiersJson} />
          <input type="hidden" name="discountType" value={discountType} />
          <input type="hidden" name="combinesWithShipping" value={String(combinesWith.shippingDiscounts)} />
          <input type="hidden" name="combinesWithOrder" value={String(combinesWith.orderDiscounts)} />
          <input type="hidden" name="combinesWithProduct" value={String(combinesWith.productDiscounts)} />

          <s-stack direction="block" gap="base">

            {/* ── Status bar ── */}
            <s-section>
              <s-stack direction="inline" gap="base">
                <s-badge tone={STATUS_TONES[loaderData.status] ?? "neutral"}>
                  {STATUS_LABELS[loaderData.status] ?? "Unknown"}
                </s-badge>
                <s-text subdued>
                  {isVip
                    ? (loaderData.discountMethod === "code" ? "Code discount" : "Automatic discount")
                    : "Automatic discount"
                  } · ID: {loaderData.id.split("/").pop()}
                </s-text>
              </s-stack>
            </s-section>

            {/* ── Errors ── */}
            {errors.length > 0 && (
              <s-section>
                <s-banner tone="critical" heading="Could not save campaign">
                  {errors.map((e, i) => <s-paragraph key={i}>{e.message}</s-paragraph>)}
                </s-banner>
              </s-section>
            )}

            {/* ── Delete confirmation ── */}
            {showDeleteConfirm && (
              <s-section>
                <s-banner tone="critical" heading={`Delete "${loaderData.title}"?`}>
                  <s-paragraph>This action is permanent and cannot be undone.</s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <deleter.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="campaignType" value={loaderData.type} />
                      <s-button type="submit" variant="destructive" {...(isDeleting ? { loading: true } : {})}>
                        Yes, delete
                      </s-button>
                    </deleter.Form>
                    <s-button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>Cancel</s-button>
                  </s-stack>
                </s-banner>
              </s-section>
            )}

            {/* ── Discount code (VIP read-only) ── */}
            {isVip && loaderData.discountCode && (
              <s-section heading="Discount code">
                <s-stack direction="block" gap="tight">
                  <span style={{
                    display: "inline-flex", alignItems: "center", padding: "8px 14px",
                    background: "#F1F8FF", border: "1px solid #B0D0FF", borderRadius: "8px",
                    fontSize: "16px", fontWeight: "700", letterSpacing: "0.05em", color: "#0070F3",
                  }}>
                    {loaderData.discountCode}
                  </span>
                  <s-text subdued>The discount code cannot be changed after creation.</s-text>
                </s-stack>
              </s-section>
            )}

            {/* ── Campaign name ── */}
            <s-section heading="Campaign name">
              <s-text-field label="Name" name="title" required
                defaultValue={loaderData.title}
                details="Customers will see this name at checkout."
              />
            </s-section>

            {/* ════ VOLUME SECTIONS ════ */}
            {!isVip && (
              <>
                <s-section heading="Applies to">
                  <s-stack direction="block" gap="base">
                    <s-select label="Select by" value={appliesToType}
                      onChange={(e) => { setAppliesToType(e.currentTarget.value); setSelectedProducts([]); setSelectedCollections([]); }}>
                      <s-option value="products">Specific products</s-option>
                      <s-option value="collections">Specific collections</s-option>
                    </s-select>

                    {appliesToType === "products" && (
                      <s-stack direction="block" gap="tight">
                        <s-button variant="secondary" onClick={handlePickProducts}>
                          {selectedProducts.length > 0 ? "Edit products" : "Browse products"}
                        </s-button>
                        {selectedProducts.length > 0 ? (
                          <s-stack direction="block" gap="tight">
                            {selectedProducts.map((p) => (
                              <div key={p.id} style={resourceRowStyle}>
                                <s-text>{p.title}</s-text>
                                <s-button variant="tertiary" onClick={() => setSelectedProducts((prev) => prev.filter((x) => x.id !== p.id))}>Remove</s-button>
                              </div>
                            ))}
                          </s-stack>
                        ) : <s-box padding="base" background="subdued" borderRadius="base"><s-text subdued>No products selected</s-text></s-box>}
                      </s-stack>
                    )}

                    {appliesToType === "collections" && (
                      <s-stack direction="block" gap="tight">
                        <s-button variant="secondary" onClick={handlePickCollections}>
                          {selectedCollections.length > 0 ? "Edit collections" : "Browse collections"}
                        </s-button>
                        {selectedCollections.length > 0 ? (
                          <s-stack direction="block" gap="tight">
                            {selectedCollections.map((c) => (
                              <div key={c.id} style={resourceRowStyle}>
                                <div>
                                  <s-text emphasis="bold">{c.title}</s-text>
                                  {c.productsCount != null && <s-text subdued>{c.productsCount} products</s-text>}
                                </div>
                                <s-button variant="tertiary" onClick={() => setSelectedCollections((prev) => prev.filter((x) => x.id !== c.id))}>Remove</s-button>
                              </div>
                            ))}
                          </s-stack>
                        ) : <s-box padding="base" background="subdued" borderRadius="base"><s-text subdued>No collections selected</s-text></s-box>}
                      </s-stack>
                    )}
                  </s-stack>
                </s-section>

                <s-section heading="Volume tiers">
                  <s-stack direction="block" gap="base">
                    <s-text subdued>Define quantity thresholds and bundle prices. The best applicable tier wins.</s-text>
                    {tierError && <s-banner tone="critical">{tierError}</s-banner>}
                    <s-stack direction="block" gap="tight">
                      {tiers.map((tier, i) => (
                        <TierRow key={i} tier={tier} index={i}
                          onChange={(updated) => updateTier(i, updated)}
                          onRemove={() => removeTier(i)}
                          canRemove={tiers.length > 1}
                        />
                      ))}
                    </s-stack>
                    <s-button variant="secondary" onClick={addTier}>Add tier</s-button>
                  </s-stack>
                </s-section>
              </>
            )}

            {/* ════ VIP SECTIONS ════ */}
            {isVip && (
              <>
                <s-section heading="Discount value">
                  <s-stack direction="block" gap="base">
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                      <s-select label="Discount type" value={discountType} onChange={(e) => setDiscountType(e.currentTarget.value)}>
                        <s-option value="percentage">Percentage</s-option>
                        <s-option value="fixed">Fixed amount</s-option>
                      </s-select>
                      <s-number-field
                        label={discountType === "fixed" ? "Discount amount" : "Discount value"}
                        name="discountPercentage" required
                        min={discountType === "fixed" ? 0.01 : 1}
                        max={discountType === "percentage" ? 100 : undefined}
                        step={discountType === "fixed" ? 0.01 : 1}
                        defaultValue={loaderData.discountPercentage}
                        {...(discountType === "fixed" ? { prefix: "$" } : { suffix: "%" })}
                      />
                    </div>
                    <s-divider />
                    <s-select label="Applies to" value={appliesToType}
                      onChange={(e) => { setAppliesToType(e.currentTarget.value); setSelectedProducts([]); setSelectedCollections([]); }}>
                      <s-option value="all">All products</s-option>
                      <s-option value="products">Specific products</s-option>
                      <s-option value="collections">Specific collections</s-option>
                    </s-select>

                    {appliesToType === "products" && (
                      <s-stack direction="block" gap="tight">
                        <s-button variant="secondary" onClick={handlePickProducts}>
                          {selectedProducts.length > 0 ? "Edit products" : "Browse products"}
                        </s-button>
                        {selectedProducts.length > 0 ? (
                          <s-stack direction="block" gap="tight">
                            {selectedProducts.map((p) => (
                              <div key={p.id} style={resourceRowStyle}>
                                <s-text>{p.title}</s-text>
                                <s-button variant="tertiary" onClick={() => setSelectedProducts((prev) => prev.filter((x) => x.id !== p.id))}>Remove</s-button>
                              </div>
                            ))}
                          </s-stack>
                        ) : <s-box padding="base" background="subdued" borderRadius="base"><s-text subdued>No products selected</s-text></s-box>}
                      </s-stack>
                    )}

                    {appliesToType === "collections" && (
                      <s-stack direction="block" gap="tight">
                        <s-button variant="secondary" onClick={handlePickCollections}>
                          {selectedCollections.length > 0 ? "Edit collections" : "Browse collections"}
                        </s-button>
                        {selectedCollections.length > 0 ? (
                          <s-stack direction="block" gap="tight">
                            {selectedCollections.map((c) => (
                              <div key={c.id} style={resourceRowStyle}>
                                <div>
                                  <s-text emphasis="bold">{c.title}</s-text>
                                  {c.productsCount != null && <s-text subdued>{c.productsCount} products</s-text>}
                                </div>
                                <s-button variant="tertiary" onClick={() => setSelectedCollections((prev) => prev.filter((x) => x.id !== c.id))}>Remove</s-button>
                              </div>
                            ))}
                          </s-stack>
                        ) : <s-box padding="base" background="subdued" borderRadius="base"><s-text subdued>No collections selected</s-text></s-box>}
                      </s-stack>
                    )}
                  </s-stack>
                </s-section>

                <s-section heading="Customer eligibility">
                  <s-text-field label="Customer tags" name="customerTags" required
                    defaultValue={loaderData.customerTags} placeholder="VIP, Gold, Premium"
                    details="Comma-separated. Any customer with at least one matching tag qualifies."
                  />
                </s-section>
              </>
            )}

            {/* ── Active dates (shared) ── */}
            <s-section heading="Active dates">
              <s-stack direction="block" gap="base">
                <s-date-field label="Start date" name="startsAt"
                  defaultValue={toDateOnly(loaderData.startsAt)}
                  details="Discount activates on this date."
                />
                <s-divider />
                <s-date-field label="End date" name="endsAt"
                  defaultValue={toDateOnly(loaderData.endsAt)}
                  details="Leave blank to run indefinitely."
                />
              </s-stack>
            </s-section>

          </s-stack>
        </updater.Form>

        {/* ── Aside: Summary ── */}
        <s-section slot="aside" heading="Summary">
          <s-stack direction="block" gap="tight">
            <div>
              <s-text subdued>Type</s-text>
              <s-text>{isVip ? "VIP Customer Discount" : "Volume Discount"}</s-text>
            </div>
            <s-divider />
            <div>
              <s-text subdued>Applies to</s-text>
              <s-text>{targetStr}</s-text>
            </div>
            {!isVip && (
              <>
                <s-divider />
                <div>
                  <s-text subdued>Tiers</s-text>
                  {tiers.filter((t) => t.quantity && t.totalPrice).length === 0 ? (
                    <s-text subdued>No tiers defined</s-text>
                  ) : (
                    <s-stack direction="block" gap="extraTight">
                      {[...tiers].filter((t) => t.quantity && t.totalPrice).sort((a, b) => a.quantity - b.quantity).map((t, i) => (
                        <s-text key={i}>• Any {t.quantity} for ₹{t.totalPrice}</s-text>
                      ))}
                    </s-stack>
                  )}
                </div>
              </>
            )}
            <s-divider />
            <div>
              <s-text subdued>Status</s-text>
              <s-badge tone={STATUS_TONES[loaderData.status] ?? "neutral"}>
                {STATUS_LABELS[loaderData.status] ?? "Unknown"}
              </s-badge>
            </div>
            {activeCombinations.length > 0 && (
              <>
                <s-divider />
                <div>
                  <s-text subdued>Combines with</s-text>
                  <s-text>{activeCombinations.join(", ")}</s-text>
                </div>
              </>
            )}
          </s-stack>
        </s-section>

        {/* ── Aside: Combinations ── */}
        <s-section slot="aside" heading="Combinations">
          <s-stack direction="block" gap="tight">
            <s-text subdued>This discount can be combined with:</s-text>
            {COMBINES_WITH_OPTIONS.map(({ key, label }) => (
              <s-checkbox key={key} label={label} checked={combinesWith[key]}
                onChange={(e) => { const checked = e.currentTarget.checked; setCombinesWith((prev) => ({ ...prev, [key]: checked })); }}
              />
            ))}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
