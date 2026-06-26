package io.reporthub.reportstudio.security;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;
import org.springframework.stereotype.Component;

/**
 * JPA converter that transparently encrypts a secret column on write and decrypts it on read, so the
 * rest of the code keeps using the plain getter/setter. Applied to {@code EngineInstance.authToken}.
 * Spring Boot wires this Spring-managed converter into Hibernate (bean-container=spring) automatically.
 */
@Component
@Converter
public class AuthTokenConverter implements AttributeConverter<String, String> {

    private final EncryptionService encryption;

    public AuthTokenConverter(EncryptionService encryption) {
        this.encryption = encryption;
    }

    @Override
    public String convertToDatabaseColumn(String attribute) {
        return encryption.encrypt(attribute);
    }

    @Override
    public String convertToEntityAttribute(String dbData) {
        return encryption.decrypt(dbData);
    }
}
