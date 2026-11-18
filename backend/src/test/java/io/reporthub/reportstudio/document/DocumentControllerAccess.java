package io.reporthub.reportstudio.document;

/** Test bridge to package-private DocumentController helpers. */
public final class DocumentControllerAccess {
    private DocumentControllerAccess() {}
    public static void validate(com.fasterxml.jackson.databind.JsonNode n) { DocumentController.validateContent(n); }
    public static String defaultContent() { return DocumentController.DEFAULT_CONTENT; }
}
