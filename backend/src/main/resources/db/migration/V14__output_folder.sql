-- Per-report output folder pattern. Placeholders: {code} {category} {unit} {fmt} {yyyy} {MM} {dd}.
-- NULL keeps the default "{code}" folder. Output Files browses these as a real folder tree.
ALTER TABLE report ADD COLUMN output_folder VARCHAR(255);
