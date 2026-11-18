-- English UI: parameter labels (and static option labels) in English.
-- (V9 already seeds English labels/values; this follow-up keeps them explicit
-- and is idempotent.)

UPDATE param_def SET label = 'Fiscal year'       WHERE name = 'fiscalYear';
UPDATE param_def SET label = 'Quarter'           WHERE name = 'quarter';
UPDATE param_def SET label = 'Region'            WHERE name = 'regionCode';
UPDATE param_def SET label = 'Branch'            WHERE name = 'branchCode';
UPDATE param_def SET label = 'Channel'           WHERE name = 'channel';
UPDATE param_def SET label = 'Include subtotals' WHERE name = 'includeSubtotals';
UPDATE param_def SET label = 'Language'          WHERE name = 'lang';
UPDATE param_def SET label = 'Compare year'      WHERE name = 'compareYear';

UPDATE param_def SET options_json =
  '[{"value":"Q1","label":"Q1"},{"value":"Q2","label":"Q2"},{"value":"Q3","label":"Q3"},{"value":"Q4","label":"Q4"},{"value":"FULL","label":"Full year"}]'
  WHERE name = 'quarter';

UPDATE param_def SET options_json =
  '[{"value":"online","label":"Online"},{"value":"instore","label":"In-store"},{"value":"wholesale","label":"Wholesale"},{"value":"dealer","label":"Dealer"}]'
  WHERE name = 'channel';

UPDATE param_def SET options_json =
  '[{"value":"th","label":"Thai"},{"value":"en","label":"English"}]'
  WHERE name = 'lang';
