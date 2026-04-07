import { useState, useCallback } from "react";
import { useFetcher, useRouteError, useNavigate } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";

const GET_COLLECTION_PRODUCTS = `#graphql
  query GetCollectionProducts($id: ID!) {
    collection(id: $id) { products(first: 250) { nodes { id } } }
  }
`;

const CREATE_VOLUME = `#graphql
  mutation CreateVolume($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const CREATE_VIP_AUTO = `#graphql
  mutation CreateVipAuto($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const CREATE_VIP_CODE = `#graphql
  mutation CreateVipCode($discount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $discount) {
      codeAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const campaignType = form.get("campaignType") ?? "volume";
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
      (data?.collection?.products?.nodes ?? []).forEach(({ id }) => {
        if (!allProductIds.includes(id)) allProductIds.push(id);
      });
    }

    const startsAt = form.get("startsAt")
      ? new Date(form.get("startsAt")).toISOString()
      : new Date().toISOString();
    const endsAtRaw = form.get("endsAt");
    const endsAt = endsAtRaw ? new Date(endsAtRaw).toISOString() : null;

    if (campaignType === "volume") {
      const tiers = JSON.parse(form.get("tiers") ?? "[]");
      const config = JSON.stringify({ productIds: allProductIds, collectionIds, tiers });
      const res = await admin.graphql(CREATE_VOLUME, {
        variables: {
          discount: {
            title, functionHandle: "volume-discount", startsAt,
            ...(endsAt ? { endsAt } : {}), combinesWith,
            metafields: [{ namespace: "$app:volume-campaigns", key: "config", type: "json", value: config }],
          },
        },
      });
      const { data } = await res.json();
      const errors = data?.discountAutomaticAppCreate?.userErrors;
      if (errors?.length) return { errors };
      return redirect("/app/campaigns");
    }

    if (campaignType === "vip") {
      const tagsRaw = form.get("customerTags") ?? "";
      const customerTags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const discountPercentage = Number(form.get("discountPercentage"));
      const discountType = form.get("discountType") ?? "percentage";
      const discountMethod = form.get("discountMethod") ?? "automatic";
      const discountCode = form.get("discountCode") ?? "";
      const config = JSON.stringify({
        customerTags, productIds: allProductIds, discountPercentage, discountType, collectionIds, discountMethod,
      });
      const baseInput = {
        title, functionHandle: "discount-function", startsAt,
        ...(endsAt ? { endsAt } : {}), combinesWith,
        metafields: [{ namespace: "$app:discount-function", key: "config", type: "json", value: config }],
      };

      if (discountMethod === "code") {
        const res = await admin.graphql(CREATE_VIP_CODE, {
          variables: { discount: { ...baseInput, code: discountCode } },
        });
        const { data } = await res.json();
        const errors = data?.discountCodeAppCreate?.userErrors;
        if (errors?.length) return { errors };
      } else {
        const res = await admin.graphql(CREATE_VIP_AUTO, { variables: { discount: baseInput } });
        const { data } = await res.json();
        const errors = data?.discountAutomaticAppCreate?.userErrors;
        if (errors?.length) return { errors };
      }
      return redirect("/app/campaigns");
    }
  }

  return null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const resourceRowStyle = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 14px", border: "1px solid #E1E3E5", borderRadius: "8px",
};

const COMBINES_WITH_OPTIONS = [
  { key: "shippingDiscounts", label: "Shipping discounts" },
  { key: "orderDiscounts",    label: "Order discounts" },
  { key: "productDiscounts",  label: "Other product discounts" },
];

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function TierRow({ tier, index, onChange, onRemove, canRemove }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "12px" }}>
      <div style={{ flex: 1 }}>
        <s-number-field
          label={index === 0 ? "Quantity" : undefined}
          value={String(tier.quantity)} min={1} step={1} placeholder="e.g. 2"
          onInput={(e) => { const v = parseInt(e.currentTarget.value, 10); onChange({ ...tier, quantity: isNaN(v) ? "" : v }); }}
        />
      </div>
      <div style={{ flex: 1 }}>
        <s-number-field
          label={index === 0 ? "Total price (₹)" : undefined}
          value={String(tier.totalPrice)} min={0} step={1} placeholder="e.g. 699" prefix="₹"
          onInput={(e) => { const v = parseFloat(e.currentTarget.value); onChange({ ...tier, totalPrice: isNaN(v) ? "" : v }); }}
        />
      </div>
      {canRemove && <s-button variant="tertiary" onClick={onRemove}>Remove</s-button>}
    </div>
  );
}

function DateTimeField({ label, name, value, onChange, helperText }) {
  return (
    <div>
      <div style={{ fontSize: "13px", fontWeight: "500", color: "#1c2024", marginBottom: "6px" }}>{label}</div>
      <input
        type="datetime-local"
        name={name}
        value={value}
        onChange={onChange}
        style={{
          width: "100%", padding: "8px 12px", fontSize: "13px",
          border: "1px solid #8C9196", borderRadius: "6px",
          background: "#fff", color: "#1c2024", boxSizing: "border-box",
        }}
      />
      {helperText && (
        <div style={{ fontSize: "12px", color: "#616161", marginTop: "4px" }}>{helperText}</div>
      )}
    </div>
  );
}

const fmtDt = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewCampaign() {
  const creator = useFetcher({ key: "create-campaign" });
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [campaignType, setCampaignType] = useState("volume");
  const [titleValue, setTitleValue] = useState("");
  const [startsAtValue, setStartsAtValue] = useState("");
  const [endsAtValue, setEndsAtValue] = useState("");

  // Volume state
  const [volProducts, setVolProducts] = useState([]);
  const [volCollections, setVolCollections] = useState([]);
  const [volAppliesToType, setVolAppliesToType] = useState("products");
  const [tiers, setTiers] = useState([{ quantity: "", totalPrice: "" }]);
  const [tierError, setTierError] = useState("");

  // VIP state
  const [discountMethod, setDiscountMethod] = useState("automatic");
  const [discountCode, setDiscountCode] = useState("");
  const [discountType, setDiscountType] = useState("percentage");
  const [vipDiscountValue, setVipDiscountValue] = useState("");
  const [vipAppliesToType, setVipAppliesToType] = useState("all");
  const [vipProducts, setVipProducts] = useState([]);
  const [vipCollections, setVipCollections] = useState([]);
  const [customerTagsValue, setCustomerTagsValue] = useState("VIP");

  // Shared
  const [combinesWith, setCombinesWith] = useState({
    shippingDiscounts: true, orderDiscounts: false, productDiscounts: false,
  });

  const errors = creator.data?.errors ?? [];
  const isSubmitting = creator.state !== "idle";

  // Pickers
  const handlePickVolProducts = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: volProducts.map((p) => ({ id: p.id })) });
    if (result) setVolProducts(result.map((p) => ({ id: p.id, title: p.title })));
  }, [shopify, volProducts]);

  const handlePickVolCollections = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "collection", multiple: true, selectionIds: volCollections.map((c) => ({ id: c.id })) });
    if (result) setVolCollections(result.map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount })));
  }, [shopify, volCollections]);

  const handlePickVipProducts = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: vipProducts.map((p) => ({ id: p.id })) });
    if (result) setVipProducts(result.map((p) => ({ id: p.id, title: p.title })));
  }, [shopify, vipProducts]);

  const handlePickVipCollections = useCallback(async () => {
    const result = await shopify.resourcePicker({ type: "collection", multiple: true, selectionIds: vipCollections.map((c) => ({ id: c.id })) });
    if (result) setVipCollections(result.map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount })));
  }, [shopify, vipCollections]);

  // Tier management
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
    if (campaignType === "volume") {
      const err = validateTiers();
      if (err) { setTierError(err); return; }
      setTierError("");
    }
    const form = document.getElementById("create-campaign-form");
    if (form) creator.submit(form, { method: "post" });
  };

  const tiersJson = JSON.stringify(tiers.map((t) => ({ quantity: Number(t.quantity), totalPrice: Number(t.totalPrice) })));
  const activeCombinations = COMBINES_WITH_OPTIONS.filter(({ key }) => combinesWith[key]).map(({ label }) => label);

  // Build summary bullet list
  const summaryBullets = [];
  if (campaignType === "volume") {
    if (volAppliesToType === "products" && volProducts.length > 0)
      summaryBullets.push(`Applies to ${volProducts.length} product${volProducts.length !== 1 ? "s" : ""}`);
    else if (volAppliesToType === "collections" && volCollections.length > 0)
      summaryBullets.push(`Applies to ${volCollections.length} collection${volCollections.length !== 1 ? "s" : ""}`);
    const validTiers = [...tiers].filter((t) => t.quantity && t.totalPrice).sort((a, b) => a.quantity - b.quantity);
    validTiers.forEach((t) => summaryBullets.push(`Any ${t.quantity} items for ₹${t.totalPrice}`));
  } else {
    if (discountMethod === "code" && discountCode) summaryBullets.push(`Code: ${discountCode}`);
    if (vipDiscountValue)
      summaryBullets.push(discountType === "fixed" ? `$${vipDiscountValue} off` : `${vipDiscountValue}% off`);
    if (vipAppliesToType === "all") summaryBullets.push("Applies to all products");
    else if (vipAppliesToType === "products" && vipProducts.length > 0)
      summaryBullets.push(`Applies to ${vipProducts.length} product${vipProducts.length !== 1 ? "s" : ""}`);
    else if (vipAppliesToType === "collections" && vipCollections.length > 0)
      summaryBullets.push(`Applies to ${vipCollections.length} collection${vipCollections.length !== 1 ? "s" : ""}`);
    const tags = customerTagsValue.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length > 0) summaryBullets.push(`Tags: ${tags.join(", ")}`);
  }
  if (activeCombinations.length > 0)
    summaryBullets.push(`Combines with ${activeCombinations.join(", ").toLowerCase()}`);
  const startLabel = fmtDt(startsAtValue);
  const endLabel = fmtDt(endsAtValue);
  if (startLabel && endLabel) summaryBullets.push(`Active ${startLabel} – ${endLabel}`);
  else if (startLabel) summaryBullets.push(`Starts ${startLabel}`);

  const submitProducts = campaignType === "volume"
    ? (volAppliesToType === "products" ? volProducts : [])
    : (vipAppliesToType === "products" ? vipProducts : []);
  const submitCollections = campaignType === "volume"
    ? (volAppliesToType === "collections" ? volCollections : [])
    : (vipAppliesToType === "collections" ? vipCollections : []);

  return (
    <s-page heading="Create campaign">
      <s-button slot="primary-action" variant="primary" onClick={handleSubmit} {...(isSubmitting ? { loading: true } : {})}>
        Save campaign
      </s-button>

      <creator.Form id="create-campaign-form" method="post">
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="campaignType" value={campaignType} />
        <input type="hidden" name="productIds" value={JSON.stringify(submitProducts.map((p) => p.id))} />
        <input type="hidden" name="collectionIds" value={JSON.stringify(submitCollections.map((c) => c.id))} />
        <input type="hidden" name="tiers" value={tiersJson} />
        <input type="hidden" name="discountMethod" value={discountMethod} />
        <input type="hidden" name="discountType" value={discountType} />
        <input type="hidden" name="combinesWithShipping" value={String(combinesWith.shippingDiscounts)} />
        <input type="hidden" name="combinesWithOrder" value={String(combinesWith.orderDiscounts)} />
        <input type="hidden" name="combinesWithProduct" value={String(combinesWith.productDiscounts)} />

        <s-stack direction="block" gap="base">

          {errors.length > 0 && (
            <s-section>
              <s-banner tone="critical" heading="Could not save campaign">
                {errors.map((e, i) => <s-paragraph key={i}>{e.message}</s-paragraph>)}
              </s-banner>
            </s-section>
          )}

          {/* ── Campaign type ── */}
          <s-section heading="Campaign type">
            <s-choice-list label="Type" onChange={(e) => setCampaignType(e.currentTarget.values?.[0] ?? "volume")}>
              <s-choice value="volume" {...(campaignType === "volume" ? { selected: true } : {})}>
                Volume Discount
                <s-text slot="details">Offer tiered bundle pricing — customers pay less per unit when buying more.</s-text>
              </s-choice>
              <s-choice value="vip" {...(campaignType === "vip" ? { selected: true } : {})}>
                VIP Customer Discount
                <s-text slot="details">Give customers with specific tags a percentage or fixed-amount discount.</s-text>
              </s-choice>
            </s-choice-list>
          </s-section>

          {/* ── Title ── */}
          <s-section heading="Title">
            <s-text-field
              label="Title" name="title" required
              value={titleValue}
              onInput={(e) => { const v = e.currentTarget.value; setTitleValue(v); }}
              placeholder={campaignType === "volume" ? "e.g. Summer Bundle Deal" : "e.g. VIP Members — 20% Off"}
              details="Customers will see this name at checkout."
            />
          </s-section>

          {/* ════ VOLUME ════ */}
          {campaignType === "volume" && (
            <>
              <s-section heading="Applies to">
                <s-stack direction="block" gap="base">
                  <s-select label="Select by" value={volAppliesToType}
                    onChange={(e) => { setVolAppliesToType(e.currentTarget.value); setVolProducts([]); setVolCollections([]); }}>
                    <s-option value="products">Specific products</s-option>
                    <s-option value="collections">Specific collections</s-option>
                  </s-select>

                  {volAppliesToType === "products" && (
                    <s-stack direction="block" gap="tight">
                      <s-button variant="secondary" onClick={handlePickVolProducts}>Browse products</s-button>
                      {volProducts.map((p) => (
                        <div key={p.id} style={resourceRowStyle}>
                          <s-text>{p.title}</s-text>
                          <s-button variant="tertiary" onClick={() => setVolProducts((prev) => prev.filter((x) => x.id !== p.id))}>Remove</s-button>
                        </div>
                      ))}
                    </s-stack>
                  )}

                  {volAppliesToType === "collections" && (
                    <s-stack direction="block" gap="tight">
                      <s-button variant="secondary" onClick={handlePickVolCollections}>Browse collections</s-button>
                      {volCollections.map((c) => (
                        <div key={c.id} style={resourceRowStyle}>
                          <div>
                            <s-text emphasis="bold">{c.title}</s-text>
                            {c.productsCount != null && <div style={{ fontSize: "12px", color: "#616161" }}>{c.productsCount} products</div>}
                          </div>
                          <s-button variant="tertiary" onClick={() => setVolCollections((prev) => prev.filter((x) => x.id !== c.id))}>Remove</s-button>
                        </div>
                      ))}
                    </s-stack>
                  )}
                </s-stack>
              </s-section>

              <s-section heading="Volume tiers">
                <s-stack direction="block" gap="base">
                  <s-paragraph>Define quantity thresholds and their bundle prices. The best applicable tier wins.</s-paragraph>
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

          {/* ════ VIP ════ */}
          {campaignType === "vip" && (
            <>
              <s-section heading="Method">
                <s-stack direction="block" gap="base">
                  <s-choice-list label="Discount method" onChange={(e) => setDiscountMethod(e.currentTarget.values?.[0] ?? "automatic")}>
                    <s-choice value="automatic" {...(discountMethod === "automatic" ? { selected: true } : {})}>
                      Automatic discount
                      <s-text slot="details">Applies automatically — no code required.</s-text>
                    </s-choice>
                    <s-choice value="code" {...(discountMethod === "code" ? { selected: true } : {})}>
                      Discount code
                      <s-text slot="details">Customer enters a code at checkout.</s-text>
                    </s-choice>
                  </s-choice-list>
                  {discountMethod === "code" && (
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <s-text-field label="Discount code" name="discountCode" required
                          placeholder="e.g. VIP20" value={discountCode}
                          onInput={(e) => { const v = e.currentTarget.value; setDiscountCode(v); }}
                        />
                      </div>
                      <s-button variant="secondary" onClick={() => setDiscountCode(generateCode())}>Generate</s-button>
                    </div>
                  )}
                </s-stack>
              </s-section>

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
                      placeholder="0"
                      {...(discountType === "fixed" ? { prefix: "$" } : { suffix: "%" })}
                      onInput={(e) => { const v = e.currentTarget.value; setVipDiscountValue(v); }}
                    />
                  </div>
                  <s-divider />
                  <s-select label="Applies to" value={vipAppliesToType}
                    onChange={(e) => { setVipAppliesToType(e.currentTarget.value); setVipProducts([]); setVipCollections([]); }}>
                    <s-option value="all">All products</s-option>
                    <s-option value="products">Specific products</s-option>
                    <s-option value="collections">Specific collections</s-option>
                  </s-select>

                  {vipAppliesToType === "products" && (
                    <s-stack direction="block" gap="tight">
                      <s-button variant="secondary" onClick={handlePickVipProducts}>Browse products</s-button>
                      {vipProducts.map((p) => (
                        <div key={p.id} style={resourceRowStyle}>
                          <s-text>{p.title}</s-text>
                          <s-button variant="tertiary" onClick={() => setVipProducts((prev) => prev.filter((x) => x.id !== p.id))}>Remove</s-button>
                        </div>
                      ))}
                    </s-stack>
                  )}

                  {vipAppliesToType === "collections" && (
                    <s-stack direction="block" gap="tight">
                      <s-button variant="secondary" onClick={handlePickVipCollections}>Browse collections</s-button>
                      {vipCollections.map((c) => (
                        <div key={c.id} style={resourceRowStyle}>
                          <div>
                            <s-text emphasis="bold">{c.title}</s-text>
                            {c.productsCount != null && <div style={{ fontSize: "12px", color: "#616161" }}>{c.productsCount} products</div>}
                          </div>
                          <s-button variant="tertiary" onClick={() => setVipCollections((prev) => prev.filter((x) => x.id !== c.id))}>Remove</s-button>
                        </div>
                      ))}
                    </s-stack>
                  )}
                </s-stack>
              </s-section>

              <s-section heading="Customer eligibility">
                <s-text-field label="Customer tags" name="customerTags" required
                  placeholder="VIP, Gold, Premium"
                  value={customerTagsValue}
                  onInput={(e) => { const v = e.currentTarget.value; setCustomerTagsValue(v); }}
                  details="Comma-separated. Any customer with at least one matching tag qualifies."
                />
              </s-section>
            </>
          )}

          {/* ── Active dates ── */}
          <s-section heading="Active dates">
            <s-stack direction="block" gap="base">
              <DateTimeField
                label="Start date and time"
                name="startsAt"
                value={startsAtValue}
                onChange={(e) => setStartsAtValue(e.target.value)}
                helperText="Leave blank to start immediately."
              />
              <s-divider />
              <DateTimeField
                label="End date and time"
                name="endsAt"
                value={endsAtValue}
                onChange={(e) => setEndsAtValue(e.target.value)}
                helperText="Leave blank to run indefinitely."
              />
            </s-stack>
          </s-section>

          {/* ── Combinations ── */}
          <s-section heading="Combinations">
            <s-stack direction="block" gap="tight">
              <s-paragraph>This discount can be combined with:</s-paragraph>
              {COMBINES_WITH_OPTIONS.map(({ key, label }) => (
                <s-checkbox key={key} label={label} checked={combinesWith[key]}
                  onChange={(e) => { const checked = e.currentTarget.checked; setCombinesWith((prev) => ({ ...prev, [key]: checked })); }}
                />
              ))}
            </s-stack>
          </s-section>

          {/* ── Bottom actions ── */}
          <s-section>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={handleSubmit} {...(isSubmitting ? { loading: true } : {})}>Save campaign</s-button>
              <s-button variant="secondary" onClick={() => navigate("/app/campaigns")}>Discard</s-button>
            </s-stack>
          </s-section>

        </s-stack>
      </creator.Form>

      {/* ── Aside: Summary ── */}
      <s-section slot="aside">
        <div style={{ paddingBottom: "16px", marginBottom: "16px", borderBottom: "1px solid #E1E3E5" }}>
          <div style={{ fontSize: "16px", fontWeight: "600", color: titleValue ? "#1c2024" : "#8C9196", lineHeight: "1.4", marginBottom: "3px" }}>
            {titleValue || "No title"}
          </div>
          <div style={{ fontSize: "13px", color: "#616161" }}>
            {campaignType === "volume" ? "Automatic" : discountMethod === "code" ? "Discount code" : "Automatic"}
          </div>
        </div>

        <div style={{ paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid #E1E3E5" }}>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#1c2024", marginBottom: "6px" }}>Type</div>
          <div style={{ fontSize: "13px", color: "#1c2024" }}>
            {campaignType === "volume" ? "Volume discount" : "VIP customer discount"}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#1c2024", marginBottom: "8px" }}>Details</div>
          {summaryBullets.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#1c2024", lineHeight: "1.9" }}>
              {summaryBullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          ) : (
            <div style={{ fontSize: "13px", color: "#8C9196" }}>No details yet</div>
          )}
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
