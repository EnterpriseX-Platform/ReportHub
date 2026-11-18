package io.reporthub.reportstudio.iam;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/** Authentication carrying an {@link RhPrincipal}; {@link #getName()} is the username. */
public class RhAuthentication extends AbstractAuthenticationToken {

    private final RhPrincipal principal;
    private final String token;

    public RhAuthentication(RhPrincipal principal, String token, Collection<? extends GrantedAuthority> extra) {
        super(authorities(principal, extra));
        this.principal = principal;
        this.token = token;
        setAuthenticated(true);
    }

    private static List<GrantedAuthority> authorities(RhPrincipal p, Collection<? extends GrantedAuthority> extra) {
        List<GrantedAuthority> out = new ArrayList<>();
        out.add(new SimpleGrantedAuthority(p.admin() ? "ROLE_ADMIN" : "ROLE_USER"));
        if (extra != null) out.addAll(extra);
        return out;
    }

    /** Never exposed as credentials: those are forwarded to edge-fronted APIs only for gateway tokens. */
    @Override public Object getCredentials() { return null; }
    @Override public RhPrincipal getPrincipal() { return principal; }
    @Override public String getName() { return principal.username(); }
    public String getToken() { return token; }
}
