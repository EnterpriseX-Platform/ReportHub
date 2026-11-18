-- Parameter definitions are configuration owned by each deployment. Remove the example
-- definitions seeded by V9 unless a report already uses them, so a fresh install starts with an
-- empty catalog and no built-in parameter names.
DELETE FROM param_def pd
 WHERE pd.name IN ('fiscalYear', 'quarter', 'regionCode', 'branchCode', 'channel',
                   'includeSubtotals', 'lang', 'compareYear')
   AND NOT EXISTS (SELECT 1 FROM report_param rp WHERE rp.param_name = pd.name);
