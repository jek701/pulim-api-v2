/** IKPU/MXIK group/class prefixes, not OKED activity codes. Source: Cabinet resolution
 * 249 (28 April 2021), annex 1, https://lex.uz/docs/5394977 (checked 4 November 2026).
 * Commodity groups have three digits (including the leading zero); classes have five.
 * Only clear household purchase families are seeded; unknown classes remain unclassified. */
export const IKPU_SEEDS: ReadonlyArray<{ prefix: string; standardKey: string; label: string }> = [
  { prefix: '002', standardKey: 'food', label: 'Meat' },
  { prefix: '003', standardKey: 'food', label: 'Fish' },
  { prefix: '004', standardKey: 'food', label: 'Dairy, eggs and honey' },
  { prefix: '007', standardKey: 'food', label: 'Vegetables' },
  { prefix: '008', standardKey: 'food', label: 'Fruit and nuts' },
  { prefix: '009', standardKey: 'food', label: 'Coffee, tea and spices' },
  { prefix: '010', standardKey: 'food', label: 'Cereals' },
  { prefix: '016', standardKey: 'food', label: 'Prepared meat and fish' },
  { prefix: '017', standardKey: 'food', label: 'Sugar and confectionery' },
  { prefix: '018', standardKey: 'food', label: 'Cocoa and chocolate' },
  { prefix: '019', standardKey: 'food', label: 'Flour foods and bakery' },
  { prefix: '020', standardKey: 'food', label: 'Prepared vegetables and fruit' },
  { prefix: '021', standardKey: 'food', label: 'Other food preparations' },
  { prefix: '022', standardKey: 'food', label: 'Beverages' },
  { prefix: '10202', standardKey: 'food', label: 'Catering and restaurant services' },
  { prefix: '02710', standardKey: 'transport', label: 'Petroleum fuels' },
  { prefix: '03004', standardKey: 'health', label: 'Packaged medicines' },
  { prefix: '10107', standardKey: 'transport', label: 'Taxi and public transport' },
  { prefix: '10108', standardKey: 'transport', label: 'Passenger rail' },
  { prefix: '10304', standardKey: 'bills', label: 'Telecommunications' },
  { prefix: '03401', standardKey: 'shopping', label: 'Soap' },
  { prefix: '03402', standardKey: 'shopping', label: 'Cleaning agents' },
  { prefix: '061', standardKey: 'shopping', label: 'Clothing' },
  { prefix: '08471', standardKey: 'shopping', label: 'Computers' },
  { prefix: '08517', standardKey: 'shopping', label: 'Phones' },
  { prefix: '08518', standardKey: 'shopping', label: 'Headphones and audio' },
  { prefix: '08525', standardKey: 'shopping', label: 'Cameras' },
  { prefix: '08528', standardKey: 'shopping', label: 'Televisions and monitors' },
];
