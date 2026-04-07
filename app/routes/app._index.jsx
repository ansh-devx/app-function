import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useRouteError } from "react-router";
import { authenticate } from "../shopify.server";

const GET_CAMPAIGNS = `#graphql
  query GetCampaignStats {
    discountNodes(first: 250, query: "type:app") {
      nodes {
        discount {
          __typename
          ... on DiscountAutomaticApp { discountId title status startsAt endsAt }
          ... on DiscountCodeApp { discountId title status startsAt endsAt }
        }
        volumeMeta: metafield(namespace: "$app:volume-campaigns", key: "config") { value }
        vipMeta: metafield(namespace: "$app:discount-function", key: "config") { value }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const res = await admin.graphql(GET_CAMPAIGNS);
  const { data } = await res.json();

  const validTypes = ["DiscountAutomaticApp", "DiscountCodeApp"];
  const nodes = (data?.discountNodes?.nodes ?? []).filter(
    (n) => (n.volumeMeta || n.vipMeta) && validTypes.includes(n.discount?.__typename)
  );

  const stats = { ACTIVE: 0, SCHEDULED: 0, PAUSED: 0, EXPIRED: 0 };
  const recent = [];

  for (const n of nodes) {
    const d = n.discount;
    const isVip = !!n.vipMeta;
    let config = {};
    try { config = JSON.parse(isVip ? n.vipMeta.value : n.volumeMeta.value); } catch {}
    const paused = isVip ? false : (config.paused ?? false);
    const status = paused ? "PAUSED" : (d.status ?? "UNKNOWN");
    if (status in stats) stats[status]++;
    if (recent.length < 5) {
      recent.push({ id: d.discountId, title: d.title, status, startsAt: d.startsAt ?? null });
    }
  }

  return { stats, recent, total: nodes.length };
};

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

const STATUS_TONE = { ACTIVE: "success", SCHEDULED: "caution", PAUSED: "neutral", EXPIRED: "neutral" };
const STATUS_LABEL = { ACTIVE: "Active", SCHEDULED: "Scheduled", PAUSED: "Paused", EXPIRED: "Expired", UNKNOWN: "Unknown" };

const STAT_CARDS = [
  { key: "ACTIVE",    label: "Active" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "PAUSED",    label: "Paused" },
  { key: "EXPIRED",   label: "Expired" },
];

const TH = { padding: "10px 16px", fontSize: "12px", fontWeight: "600", color: "#616161", textAlign: "left", background: "#FAFBFB", borderBottom: "1px solid #E1E3E5" };
const TD = { padding: "14px 16px", fontSize: "13px", color: "#1c2024", verticalAlign: "middle" };

export default function Dashboard() {
  const { stats, recent, total } = useLoaderData();
  const navigate = useNavigate();

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/campaigns/new")}>
        Create campaign
      </s-button>

      <s-section>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          {STAT_CARDS.map(({ key, label }) => (
            <div
              key={key}
              onClick={() => navigate("/app/campaigns")}
              style={{ padding: "20px 16px", borderRadius: "8px", border: "1px solid #E1E3E5", background: "#fff", cursor: "pointer" }}
            >
              <div style={{ fontSize: "30px", fontWeight: "700", color: "#1c2024", lineHeight: 1, marginBottom: "6px" }}>
                {stats[key]}
              </div>
              <div style={{ fontSize: "13px", color: "#616161" }}>{label}</div>
            </div>
          ))}
        </div>
      </s-section>

      <s-section heading="Recent campaigns">
        {total === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 24px", border: "2px dashed #E1E3E5", borderRadius: "8px" }}>
            <s-text emphasis="bold">No campaigns yet</s-text>
            <div style={{ marginTop: "8px" }}>
              <s-paragraph>Create your first campaign to offer tiered or VIP pricing.</s-paragraph>
            </div>
            <div style={{ marginTop: "16px" }}>
              <s-button variant="primary" onClick={() => navigate("/app/campaigns/new")}>Create campaign</s-button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ border: "1px solid #E1E3E5", borderRadius: "8px", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={TH}>Name</th>
                    <th style={TH}>Status</th>
                    <th style={TH}>Started</th>
                    <th style={{ ...TH, textAlign: "right" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((c, i) => {
                    const isLast = i === recent.length - 1;
                    const td = { ...TD, borderBottom: isLast ? "none" : "1px solid #E1E3E5" };
                    return (
                      <tr key={c.id}>
                        <td style={{ ...td, fontWeight: "600" }}>{c.title}</td>
                        <td style={td}>
                          <s-badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                            {STATUS_LABEL[c.status] ?? c.status}
                          </s-badge>
                        </td>
                        <td style={{ ...td, color: "#616161" }}>{fmtDate(c.startsAt)}</td>
                        <td style={{ ...td, textAlign: "right" }}>
                          <s-button variant="secondary" onClick={() => navigate(`/app/campaigns/${encodeURIComponent(c.id)}`)}>Edit</s-button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total > 5 && (
              <div style={{ marginTop: "12px", textAlign: "center" }}>
                <s-button variant="tertiary" onClick={() => navigate("/app/campaigns")}>
                  View all {total} campaigns
                </s-button>
              </div>
            )}
          </div>
        )}
      </s-section>

      <s-section slot="aside" heading="Quick actions">
        <s-stack direction="block" gap="tight">
          <s-button variant="primary" onClick={() => navigate("/app/campaigns/new")}>Create campaign</s-button>
          <s-button variant="secondary" onClick={() => navigate("/app/campaigns")}>View all campaigns</s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Offer tiered bundle pricing — customers get better deals when they buy more.
          </s-paragraph>
          <s-paragraph>
            Discounts apply automatically at checkout. No coupon codes needed.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
