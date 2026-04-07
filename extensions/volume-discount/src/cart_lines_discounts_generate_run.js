import { ProductDiscountSelectionStrategy } from '../generated/api';

/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) return { operations: [] };

  const configRaw = input.discount?.metafield?.value;
  if (!configRaw) return { operations: [] };

  let config;
  try {
    config = JSON.parse(configRaw);
  } catch {
    return { operations: [] };
  }

  if (config.paused) return { operations: [] };

  const { productIds = [], tiers = [] } = config;
  if (!tiers.length || !productIds.length) return { operations: [] };

  // Filter qualifying lines
  const qualifyingLines = input.cart.lines.filter((line) => {
    if (line.merchandise.__typename !== 'ProductVariant') return false;
    return productIds.includes(line.merchandise.product.id);
  });
  if (!qualifyingLines.length) return { operations: [] };

  // Expand to flat units sorted by price desc (highest-value units get first group)
  const units = [];
  for (const line of qualifyingLines) {
    const unitPrice = parseFloat(line.cost.amountPerQuantity.amount);
    for (let i = 0; i < line.quantity; i++) {
      units.push({ lineId: line.id, unitPrice });
    }
  }
  units.sort((a, b) => b.unitPrice - a.unitPrice);

  const totalUnits = units.length;

  // Sort tiers desc by quantity — larger tiers are tried first in DP so they
  // win ties vs. smaller tiers (e.g. 4@1299 beats 2@699+2@699 when cost is same)
  const sortedTiersDesc = [...tiers].sort((a, b) => b.quantity - a.quantity);

  // DP: find the combination of tiers that covers the most units at minimum cost.
  // Tie-break: prefer smaller max-group-size (produces more balanced groupings),
  // so 3@999 + 3@999 wins over 4@1299 + 2@699 for N=6 when both cost the same.
  //
  // dp[i] = { cost, maxGroupSize }
  const INF = Infinity;
  const dp = Array.from({ length: totalUnits + 1 }, () => ({ cost: INF, maxGroupSize: INF }));
  const parent = new Array(totalUnits + 1).fill(null);
  dp[0] = { cost: 0, maxGroupSize: 0 };

  for (let i = 1; i <= totalUnits; i++) {
    for (const tier of sortedTiersDesc) {
      if (tier.quantity > i) continue;
      const prev = dp[i - tier.quantity];
      if (prev.cost === INF) continue;

      const newCost = prev.cost + tier.totalPrice;
      const newMaxGroup = Math.max(tier.quantity, prev.maxGroupSize);
      const cur = dp[i];

      const betterCost = newCost < cur.cost;
      const sameCostBalanced = newCost === cur.cost && newMaxGroup < cur.maxGroupSize;

      if (betterCost || sameCostBalanced) {
        dp[i] = { cost: newCost, maxGroupSize: newMaxGroup };
        parent[i] = tier;
      }
    }
  }

  // Find the largest number of units we can cover
  let coverage = totalUnits;
  while (coverage > 0 && dp[coverage].cost === INF) coverage--;
  if (coverage === 0) return { operations: [] };

  // Reconstruct the tier sequence from DP parent pointers
  const tierSequence = [];
  let rem = coverage;
  while (rem > 0) {
    const tier = parent[rem];
    tierSequence.push(tier);
    rem -= tier.quantity;
  }

  // Assign units to tier groups in order and compute per-line discounts
  const lineDiscountMap = {};   // lineId -> total discount amount
  const linePrimaryTierMap = {}; // lineId -> tier that covers the most units of that line
  let unitIdx = 0;

  for (const tier of tierSequence) {
    const groupUnits = units.slice(unitIdx, unitIdx + tier.quantity);
    unitIdx += tier.quantity;

    const groupOriginal = groupUnits.reduce((sum, u) => sum + u.unitPrice, 0);
    const groupDiscount = groupOriginal - tier.totalPrice;
    if (groupDiscount <= 0) continue;

    // Count units per line in this group (for primary-tier message tracking)
    const groupLineCount = {};
    for (const unit of groupUnits) {
      groupLineCount[unit.lineId] = (groupLineCount[unit.lineId] || 0) + 1;
    }

    // Distribute discount proportionally by unit price
    for (const unit of groupUnits) {
      const share = groupDiscount * (unit.unitPrice / groupOriginal);
      lineDiscountMap[unit.lineId] = (lineDiscountMap[unit.lineId] || 0) + share;
    }

    // Track the tier that covers the most units for each line (for the message)
    for (const [lineId, count] of Object.entries(groupLineCount)) {
      if (!linePrimaryTierMap[lineId] || count > linePrimaryTierMap[lineId].count) {
        linePrimaryTierMap[lineId] = { tier, count };
      }
    }
  }

  if (!Object.keys(lineDiscountMap).length) return { operations: [] };

  // One candidate per qualifying line
  const candidates = Object.entries(lineDiscountMap).map(([lineId, discount]) => {
    const { tier } = linePrimaryTierMap[lineId];
    return {
      message: `Volume deal: any ${tier.quantity} for \u20b9${tier.totalPrice}`,
      targets: [{ cartLine: { id: lineId } }],
      value: {
        fixedAmount: { amount: String(discount.toFixed(2)) },
      },
    };
  });

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
