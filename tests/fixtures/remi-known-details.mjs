// Reconstructed label boundaries from the saved Remi sample supplied in this
// session (2026-11-19), not a fresh DOM capture. Description is only the known
// ending excerpt. Preserve source values; do not infer missing measurements.
export const remiDescriptionExcerpt = 'comes with a natural linen shade.';
export const remiKnownSpecs = {
  Dimensions: 'H53.7 x W35 x D35cm / H20.9 x W13.8 x D13.8"',
  'Packaged dimensions': 'H47 x W45 x D39cm / H18.5 x W17.7 x D15.2"',
  Weight: '6.7kg / 14.8lbs',
  'Packaged weight': '8.6kg / 19lbs',
  'Assembled size': 'H53 x W35 x D35cm',
  'Assembly required': 'Yes',
  'Base dimensions': 'H15 x W5.2 x D5.2"',
  'Bulb required': '1/E26/6W Maximum',
  'Bulb style': 'Tala 6W Globe LED',
  'Bulb(s) included': 'No',
  'Cable length': '70.9"',
  Dimmable: 'Yes',
  'Electrician required': 'No',
  'Lighting Certification US': 'UL',
  Voltage: '110-120V',
  Wattage: '6W Max',
};
export const remiKnownPanel = [
  'Details & Dimensions', remiDescriptionExcerpt, 'Download tearsheet',
  ...Object.entries(remiKnownSpecs).flatMap(([label, value]) => [label, value]),
  'Delivery & Returns',
].join('\n');
