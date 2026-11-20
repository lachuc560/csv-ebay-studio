// Shop details belong to the seller preparing this download, not shared config.
export const SELLER_EXPORT_FIELDS = [
  'ebayLocation', 'ebayCountry', 'dispatchTimeMax', 'shippingProfileName',
  'returnProfileName', 'paymentProfileName', 'returnsAcceptedOption',
  'returnsWithinOption', 'refundOption', 'shippingCostPaidByOption',
];

export function sellerExportConfig(shared = {}, currentSeller = {}) {
  // This tool exports source data for review; an unknown listing price stays
  // blank with a validation issue instead of discarding the whole product.
  const config = { ...shared, allowIncompletePrice: true };
  for (const field of SELLER_EXPORT_FIELDS) {
    config[field] = String(currentSeller[field] ?? '').trim();
  }
  config.ebayCountry = config.ebayCountry.toUpperCase();
  return config;
}
