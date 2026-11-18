-- Per-pipeline run parameters, asked for at Run time instead of being frozen into the SQL.
--
-- Running a pipeline should prompt for parameters; year defaults to the current fiscal year and
-- other parameters are configurable.
--
-- Shape: [{"name":"STAGE","label":"Stage","default":"4.4"}, …]
-- The token $NAME is replaced in source_sql and clear_where before the load, exactly like the
-- $YEAR4/$YEAR2 pair already works — those stay built in, so `year` needs no entry here.
alter table warehouse_pipeline add column params_json text;

comment on column warehouse_pipeline.params_json is
  'JSON array of {name,label,default} asked for when the pipeline is run; $NAME is substituted into source_sql and clear_where. NULL = no parameters beyond the built-in fiscal year.';
