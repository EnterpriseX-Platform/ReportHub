package io.reporthub.reportstudio.tenancy;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/** A row of another tenant/project was loaded by id while a scope was active. Mapped to 404. */
@ResponseStatus(HttpStatus.NOT_FOUND)
public class OutOfScopeException extends RuntimeException {
    public OutOfScopeException(String entity) {
        super(entity + " not found");
    }
}
