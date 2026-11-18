# Document exporter

Renders ReportHub documents to PDF. It opens the frontend print page `/print/:id` in headless
Chromium and prints it; page sizes and landscape sections come from the page's CSS `@page` rules.

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `3200` | Listen port |
| `PRINT_BASE` | `http://localhost:3000` | Frontend address as seen from the exporter, including the base path |
| `RENDER_TIMEOUT_MS` | `300000` | Max wait for the print page to report ready |

The backend reaches it through `DOC_EXPORTER_URL` (Documents "Export PDF" button) and the
`docbuilder` report engine uses it by default when a report sets no `baseUrl`.

Every export call carries `t`, a print token the backend signs (HMAC with its `DOC_PRINT_KEY`) for
one document id, the caller's tenant + project and the user who asked for the PDF, valid for
`DOC_PRINT_TOKEN_TTL_SECONDS` (default 1800). The exporter passes it to the print page, which reads
the document and its data as that user — row filters and object ACLs apply as on screen, and a
token cannot open a document of another tenant or project. The exporter itself holds no secret.

Local run: `npm install && npx playwright install chromium && PRINT_BASE=http://localhost:3101 npm start`.

## Not yet ported (TODO)

- **Real-time collaboration (Yjs).** The editor saves whole documents with optimistic locking
  (`revision`; a stale save gets HTTP 409). Live co-editing would need a Yjs/Hocuspocus server and a
  shared-type model of the section tree; it was left out to keep the first version simple.
- DOCX export, spreadsheet import into tables, and chart blocks.
