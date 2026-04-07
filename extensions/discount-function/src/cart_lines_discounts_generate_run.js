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
  const NO_OPS = { operations: [] };

  const raw = input.discount?.metafield?.value;
  if (!raw) return NO_OPS;

  const { customerTags = [], productIds = [], discountPercentage, discountType = "percentage" } = JSON.parse(raw);
  if (!discountPercentage || customerTags.length === 0) return NO_OPS;

  // Check if customer has any of the configured tags
  const tagResults = input.cart.buyerIdentity?.customer?.hasTags ?? [];
  const customerQualifies = tagResults.some(
    (r) => r.hasTag && customerTags.includes(r.tag),
  );
  if (!customerQualifies) return NO_OPS;

  // Build targets from qualifying cart lines
  const targets = input.cart.lines
    .filter((line) => {
      if (line.merchandise.__typename !== 'ProductVariant') return false;
      if (productIds.length === 0) return true;
      return productIds.includes(line.merchandise.product?.id);
    })
    .map((line) => ({ cartLine: { id: line.id } }));

  if (targets.length === 0) return NO_OPS;

  const isFixed = discountType === "fixed";
  const discountValue = isFixed
    ? { fixedAmount: { amount: String(discountPercentage) } }
    : { percentage: { value: discountPercentage } };
  const message = isFixed
    ? `$${discountPercentage} VIP Discount`
    : `${discountPercentage}% VIP Discount`;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message,
              targets,
              value: discountValue,
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
