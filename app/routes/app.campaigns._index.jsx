import { useState, useRef, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const GET_CAMPAIGNS = `#graphql
  query GetCampaigns {
    discountNodes(first: 250, query: "type:app") {
      nodes {
        discount {
          __typename
          ... on DiscountAutomaticApp {
            discountId title status startsAt endsAt
            combinesWith { orderDiscounts productDiscounts shippingDiscounts }
          }
          ... on DiscountCodeApp {
            discountId title status startsAt endsAt
            codes(first: 1) { nodes { code } }
            combinesWith { orderDiscounts productDiscounts shippingDiscounts }
          }
        }
        volumeMeta: metafield(namespace: "$app:volume-campaigns", key: "config") { value }
        vipMeta: metafield(namespace: "$app:discount-function", key: "config") { value }
      }
    }
  }
`;

const CREATE_VOLUME_DUPLICATE = `#graphql
  mutation CreateVolumeDuplicate($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const UPDATE_VOLUME = `#graphql
  mutation UpdateVolumeMeta($id: ID!, $discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
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

const volumeMeta = (value) => ({ namespace: "$app:volume-campaigns", key: "config", type: "json", value });

async function deleteCampaign(admin, id) {
  const isCode = id.includes("DiscountCodeNode");
  const res = await admin.graphql(isCode ? DELETE_CODE : DELETE_AUTO, { variables: { id } });
  const { data } = await res.json();
  return isCode
    ? (data?.discountCodeDelete?.userErrors ?? [])
    : (data?.discountAutomaticDelete?.userErrors ?? []);
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const res = await admin.graphql(GET_CAMPAIGNS);
  const { data } = await res.json();

  const campaigns = (data?.discountNodes?.nodes ?? [])
    .filter((n) => {
      const validDiscount = n.discount?.__typename === "DiscountAutomaticApp" || n.discount?.__typename === "DiscountCodeApp";
      return (n.volumeMeta || n.vipMeta) && validDiscount;
    })
    .map((n) => {
      const d = n.discount;
      const isCode = d.__typename === "DiscountCodeApp";
      const isVip = !!n.vipMeta;
      let config = {};
      try { config = JSON.parse(isVip ? n.vipMeta.value : n.volumeMeta.value); } catch {}

      if (isVip) {
        return {
          id: d.discountId, type: "vip", title: d.title,
          status: d.status ?? "UNKNOWN", paused: false,
          startsAt: d.startsAt ?? null, endsAt: d.endsAt ?? null,
          isCode,
          discountCode: isCode ? (d.codes?.nodes?.[0]?.code ?? null) : null,
          customerTags: config.customerTags ?? [],
          discountValue: config.discountPercentage ?? 0,
          discountType: config.discountType ?? "percentage",
          productCount: (config.productIds ?? []).length,
          collectionCount: (config.collectionIds ?? []).length,
          combinesWith: d.combinesWith ?? {},
          tiers: [], productIds: [], collectionIds: [],
        };
      }
      const paused = config.paused ?? false;
      return {
        id: d.discountId, type: "volume", title: d.title,
        status: paused ? "PAUSED" : (d.status ?? "UNKNOWN"), paused,
        startsAt: d.startsAt ?? null, endsAt: d.endsAt ?? null,
        isCode: false, discountCode: null,
        tiers: config.tiers ?? [],
        productIds: config.productIds ?? [],
        collectionIds: config.collectionIds ?? [],
        productCount: (config.productIds ?? []).length,
        collectionCount: (config.collectionIds ?? []).length,
        combinesWith: d.combinesWith ?? {},
      };
    });

  return { campaigns };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    const id = form.get("id");
    const errors = await deleteCampaign(admin, id);
    return errors.length ? { errors } : { deletedId: id };
  }

  if (intent === "duplicate") {
    const res = await admin.graphql(CREATE_VOLUME_DUPLICATE, {
      variables: {
        discount: {
          title: `Copy of ${form.get("title")}`,
          functionHandle: "volume-discount",
          startsAt: new Date().toISOString(),
          combinesWith: JSON.parse(form.get("combinesWithJson") ?? "{}"),
          metafields: [volumeMeta(form.get("configJson"))],
        },
      },
    });
    const { data } = await res.json();
    const errors = data?.discountAutomaticAppCreate?.userErrors ?? [];
    return errors.length ? { errors } : { duplicated: true };
  }

  if (intent === "pause" || intent === "resume") {
    const id = form.get("id");
    const res = await admin.graphql(UPDATE_VOLUME, {
      variables: {
        id,
        discount: { title: form.get("title"), metafields: [volumeMeta(form.get("configJson"))] },
      },
    });
    const { data } = await res.json();
    const errors = data?.discountAutomaticAppUpdate?.userErrors ?? [];
    return errors.length ? { errors } : { toggled: id };
  }

  if (intent === "bulkDelete") {
    const ids = JSON.parse(form.get("ids") ?? "[]");
    const results = await Promise.all(ids.map((id) => deleteCampaign(admin, id)));
    const errors = results.flat();
    return errors.length ? { errors } : { bulkDeleted: true };
  }

  if (intent === "bulkToggle") {
    const items = JSON.parse(form.get("itemsJson") ?? "[]");
    const results = await Promise.all(
      items.map(({ id, title, configJson }) =>
        admin.graphql(UPDATE_VOLUME, {
          variables: { id, discount: { title, metafields: [volumeMeta(configJson)] } },
        }).then((r) => r.json())
      )
    );
    const errors = results.flatMap((r) => r.data?.discountAutomaticAppUpdate?.userErrors ?? []);
    return errors.length ? { errors } : { bulkToggled: true };
  }

  return null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_TONE = { ACTIVE: "success", SCHEDULED: "caution", PAUSED: "neutral", EXPIRED: "neutral" };
const STATUS_LABEL = { ACTIVE: "Active", SCHEDULED: "Scheduled", PAUSED: "Paused", EXPIRED: "Expired", UNKNOWN: "Unknown" };

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
  : null;

const fmtTiers = (tiers) => tiers.length
  ? [...tiers].sort((a, b) => a.quantity - b.quantity).map((t) => `${t.quantity}→₹${t.totalPrice}`).join(" · ")
  : "—";

const fmtVipValue = (c) =>
  c.discountValue ? (c.discountType === "fixed" ? `$${c.discountValue} off` : `${c.discountValue}% off`) : "—";

const fmtApplies = (pc, cc) => {
  if (pc > 0 && cc > 0) return `${pc} products, ${cc} collections`;
  if (pc > 0) return `${pc} product${pc !== 1 ? "s" : ""}`;
  if (cc > 0) return `${cc} collection${cc !== 1 ? "s" : ""}`;
  return "All products";
};

const TH = { padding: "10px 16px", fontSize: "12px", fontWeight: "600", color: "#616161", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #E1E3E5", background: "#FAFBFB" };
const TD = { padding: "14px 16px", fontSize: "13px", color: "#1c2024", verticalAlign: "middle", borderBottom: "1px solid #E1E3E5" };

function ActionMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Actions"
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "32px", height: "32px", borderRadius: "6px",
          border: "1px solid #E1E3E5", background: "#fff",
          cursor: "pointer", color: "#616161", fontSize: "20px", lineHeight: 1,
        }}
      >
        ⋮
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 200,
          background: "#fff", border: "1px solid #E1E3E5", borderRadius: "8px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.10)", minWidth: "150px", overflow: "hidden",
        }}>
          {actions.map(({ label, destructive, onAction }) => (
            <button
              key={label}
              onClick={() => { onAction(); setOpen(false); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = destructive ? "#FFF4F4" : "#F6F6F7"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              style={{
                display: "block", width: "100%", padding: "10px 14px",
                textAlign: "left", border: "none", background: "transparent",
                cursor: "pointer", fontSize: "13px",
                color: destructive ? "#D72C0D" : "#1c2024",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CampaignsList() {
  const { campaigns } = useLoaderData();
  const fetcher = useFetcher();
  const bulkFetcher = useFetcher();
  const navigate = useNavigate();

  const [selectedIds, setSelectedIds] = useState(new Set());
  const selectAllRef = useRef(null);

  const allSelected = campaigns.length > 0 && selectedIds.size === campaigns.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  useEffect(() => { setSelectedIds(new Set()); }, [campaigns]);

  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(campaigns.map((c) => c.id)));
  const toggleOne = (id) => setSelectedIds((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const submit = (data) => fetcher.submit(data, { method: "post" });

  const handleDelete = (c) => submit({ intent: "delete", id: c.id });

  const handleDuplicate = (c) => submit({
    intent: "duplicate", id: c.id, title: c.title,
    configJson: JSON.stringify({ productIds: c.productIds, collectionIds: c.collectionIds, tiers: c.tiers }),
    combinesWithJson: JSON.stringify(c.combinesWith),
  });

  const handleTogglePause = (c) => {
    const newPaused = !c.paused;
    submit({
      intent: newPaused ? "pause" : "resume",
      id: c.id, title: c.title,
      configJson: JSON.stringify({ productIds: c.productIds, collectionIds: c.collectionIds, tiers: c.tiers, paused: newPaused }),
    });
  };

  const selectedPausable  = campaigns.filter((c) => selectedIds.has(c.id) && c.type === "volume" && !c.paused);
  const selectedResumable = campaigns.filter((c) => selectedIds.has(c.id) && c.type === "volume" && c.paused);
  const isBulkWorking = bulkFetcher.state !== "idle";

  const bulkToggle = (items, paused) => bulkFetcher.submit({
    intent: "bulkToggle",
    itemsJson: JSON.stringify(items.map((c) => ({
      id: c.id, title: c.title,
      configJson: JSON.stringify({ productIds: c.productIds, collectionIds: c.collectionIds, tiers: c.tiers, paused }),
    }))),
  }, { method: "post" });

  const handleBulkDelete = () => bulkFetcher.submit(
    { intent: "bulkDelete", ids: JSON.stringify([...selectedIds]) },
    { method: "post" }
  );

  return (
    <s-page heading="Campaigns">
      <s-button variant="primary" slot="primary-action" onClick={() => navigate("/app/campaigns/new")}>
        Create campaign
      </s-button>

      <s-section>
        {campaigns.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 24px", border: "2px dashed #E1E3E5", borderRadius: "8px" }}>
            <s-text emphasis="bold">No campaigns yet</s-text>
            <div style={{ marginTop: "8px" }}>
              <s-paragraph>Create a volume discount or VIP customer campaign to get started.</s-paragraph>
            </div>
            <div style={{ marginTop: "16px" }}>
              <s-button variant="primary" onClick={() => navigate("/app/campaigns/new")}>Create your first campaign</s-button>
            </div>
          </div>
        ) : (
          <div>
            {selectedIds.size > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "10px 14px", background: "#F6F6F7", border: "1px solid #E1E3E5", borderRadius: "8px", marginBottom: "10px" }}>
                <s-text emphasis="bold">{selectedIds.size} selected</s-text>
                {selectedPausable.length > 0 && (
                  <s-button variant="secondary" onClick={() => bulkToggle(selectedPausable, true)} {...(isBulkWorking ? { loading: true } : {})}>
                    Pause {selectedPausable.length > 1 ? `(${selectedPausable.length})` : ""}
                  </s-button>
                )}
                {selectedResumable.length > 0 && (
                  <s-button variant="secondary" onClick={() => bulkToggle(selectedResumable, false)} {...(isBulkWorking ? { loading: true } : {})}>
                    Resume {selectedResumable.length > 1 ? `(${selectedResumable.length})` : ""}
                  </s-button>
                )}
                <s-button variant="destructive" onClick={handleBulkDelete} {...(isBulkWorking ? { loading: true } : {})}>
                  Delete ({selectedIds.size})
                </s-button>
                <s-button variant="tertiary" onClick={() => setSelectedIds(new Set())}>Clear</s-button>
              </div>
            )}

            <div style={{ border: "1px solid #E1E3E5", borderRadius: "8px", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, width: "40px", textAlign: "center" }}>
                      <input type="checkbox" ref={selectAllRef} checked={allSelected} onChange={toggleAll} style={{ cursor: "pointer" }} />
                    </th>
                    <th style={TH}>Name</th>
                    <th style={TH}>Type</th>
                    <th style={TH}>Details</th>
                    <th style={TH}>Applies to</th>
                    <th style={TH}>Status</th>
                    <th style={TH}>Active dates</th>
                    <th style={{ ...TH, width: "44px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c, i) => {
                    const isLast = i === campaigns.length - 1;
                    const rowTd = {
                      ...TD,
                      ...(isLast ? { borderBottom: "none" } : {}),
                      background: selectedIds.has(c.id) ? "#F6F9FF" : "transparent",
                    };

                    const menuActions = [
                      { label: "Edit", onAction: () => navigate(`/app/campaigns/${encodeURIComponent(c.id)}`) },
                      ...(c.type === "volume" ? [
                        { label: c.paused ? "Resume" : "Pause", onAction: () => handleTogglePause(c) },
                        { label: "Duplicate", onAction: () => handleDuplicate(c) },
                      ] : []),
                      { label: "Delete", destructive: true, onAction: () => handleDelete(c) },
                    ];

                    return (
                      <tr key={c.id}>
                        <td style={{ ...rowTd, textAlign: "center" }}>
                          <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleOne(c.id)} style={{ cursor: "pointer" }} />
                        </td>
                        <td style={{ ...rowTd, fontWeight: "600" }}>
                          {c.title}
                          {c.discountCode && (
                            <div style={{ marginTop: "4px" }}>
                              <span style={{
                                display: "inline-flex", padding: "2px 8px",
                                background: "#F1F8FF", border: "1px solid #B0D0FF",
                                borderRadius: "6px", fontSize: "11px", color: "#0070F3",
                                fontWeight: "700", letterSpacing: "0.06em", fontFamily: "monospace",
                              }}>
                                {c.discountCode}
                              </span>
                            </div>
                          )}
                        </td>
                        <td style={rowTd}>
                          <s-badge tone={c.type === "vip" ? "caution" : "neutral"}>
                            {c.type === "vip" ? "VIP" : "Volume"}
                          </s-badge>
                        </td>
                        <td style={{ ...rowTd, ...(c.type === "volume" ? { fontFamily: "monospace", fontSize: "12px" } : {}) }}>
                          {c.type === "volume" ? fmtTiers(c.tiers) : fmtVipValue(c)}
                        </td>
                        <td style={{ ...rowTd, color: "#616161" }}>{fmtApplies(c.productCount, c.collectionCount)}</td>
                        <td style={rowTd}>
                          <s-badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                            {STATUS_LABEL[c.status] ?? c.status}
                          </s-badge>
                        </td>
                        <td style={{ ...rowTd, color: "#616161", whiteSpace: "nowrap" }}>
                          {c.startsAt ? (
                            <>
                              <div>{fmtDate(c.startsAt)}</div>
                              <div style={{ fontSize: "12px", color: "#ADB5BD" }}>
                                {c.endsAt ? `ends ${fmtDate(c.endsAt)}` : "no end date"}
                              </div>
                            </>
                          ) : "—"}
                        </td>
                        <td style={{ ...rowTd, textAlign: "right" }}>
                          <ActionMenu actions={menuActions} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
