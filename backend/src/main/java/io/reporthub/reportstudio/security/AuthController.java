package io.reporthub.reportstudio.security;

import io.reporthub.reportstudio.iam.AuthMode;
import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.IamClient;
import io.reporthub.reportstudio.iam.IamException;
import io.reporthub.reportstudio.iam.IamPrincipalService;
import io.reporthub.reportstudio.iam.PermissionService;
import io.reporthub.reportstudio.iam.RhAuthentication;
import io.reporthub.reportstudio.iam.RhPrincipal;
import java.util.List;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * JWT auth endpoints. Mounted under {@code /auth} (full path {@code /api/auth/**}),
 * which {@link SecurityConfig} leaves public.
 */
@RestController
@RequestMapping("/auth")
public class AuthController {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final AuthMode authMode;
    private final IamPrincipalService iam;

    public AuthController(UserRepository userRepository,
                          PasswordEncoder passwordEncoder,
                          JwtService jwtService,
                          AuthMode authMode,
                          IamPrincipalService iam) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.authMode = authMode;
        this.iam = iam;
    }

    /** Verify credentials and mint a JWT. */
    @PostMapping("/login")
    public LoginResponse login(@Valid @RequestBody LoginRequest req) {
        if (authMode.isIam()) {
            // IAM mode: IAM checks the password and issues the token; the SPA sends that token back
            // as its bearer and IamBearerAuthFilter validates it on every request.
            try {
                IamClient.Login l = iam.login(req.username(), req.password());
                RhPrincipal p = iam.resolve(l.token());
                return new LoginResponse(l.token(), p.admin() ? "ADMIN" : "USER", p.displayName());
            } catch (IamException e) {
                HttpStatus st = e.status() == 401 || e.status() == 400 ? HttpStatus.UNAUTHORIZED
                        : e.status() == 403 ? HttpStatus.FORBIDDEN
                        : e.status() == 0 || e.status() >= 500 ? HttpStatus.SERVICE_UNAVAILABLE
                        : HttpStatus.BAD_GATEWAY;
                String msg = st == HttpStatus.SERVICE_UNAVAILABLE ? "Identity service is unavailable; please retry."
                        : e.getMessage() != null ? e.getMessage() : "IAM login failed";
                org.slf4j.LoggerFactory.getLogger(AuthController.class).warn("IAM login failed ({}): {}", st.value(), e.getMessage());
                throw new ResponseStatusException(st, msg);
            }
        }
        String who = attemptKey(req.username(), httpRequest);
        if (lockout.isLocked(who)) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Too many failed sign-in attempts. Try again in " + LoginLockout.WINDOW_MINUTES + " minutes.");
        }
        User user = userRepository.findByUsername(req.username())
                .filter(u -> passwordEncoder.matches(req.password(), u.getPasswordHash()))
                .orElse(null);
        if (user == null) {
            lockout.failed(who);
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid username or password");
        }
        lockout.succeeded(who);

        String token = jwtService.generate(user.getUsername(), user.getRole(), user.getTenantId());
        return new LoginResponse(token, user.getRole(), user.getDisplayName());
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private LoginLockout lockout = new LoginLockout();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private jakarta.servlet.http.HttpServletRequest httpRequest;

    static String attemptKey(String username, jakarta.servlet.http.HttpServletRequest req) {
        String ip = "";
        try {
            if (req != null) {
                String xff = req.getHeader("X-Forwarded-For");
                ip = xff != null && !xff.isBlank() ? xff.split(",")[0].trim() : req.getRemoteAddr();
            }
        } catch (Exception ignored) { /* no request bound */ }
        return (username == null ? "" : username.toLowerCase(java.util.Locale.ROOT)) + "|" + ip;
    }

    /**
     * Sign out: IAM mode evicts the token from the permission cache; local mode revokes the JWT
     * (in-memory list on this instance until the token's natural expiry).
     */
    @PostMapping("/logout")
    @org.springframework.web.bind.annotation.ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout(@org.springframework.web.bind.annotation.RequestHeader(value = "Authorization", required = false) String header) {
        if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) return;
        String token = header.substring(7).trim();
        if (token.isEmpty()) return;
        iam.evict(token);
        jwtService.revoke(token);
        if (authMode != null && authMode.isIam()) jwtService.revokeForeign(token);   // IAM token: local denylist until exp
    }

    /**
     * Re-issue a fresh JWT for the current bearer (sliding session). Requires a valid,
     * not-yet-expired token; the frontend calls this in the background while the user
     * is active so working sessions never hit the hard TTL.
     */
    @PostMapping("/refresh")
    public LoginResponse refresh(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Not authenticated");
        }
        if (authentication instanceof RhAuthentication rh && "iam".equals(rh.getPrincipal().source())) {
            // IAM tokens are renewed by IAM; hand the same one back.
            RhPrincipal p = rh.getPrincipal();
            return new LoginResponse(rh.getToken(), p.admin() ? "ADMIN" : "USER", p.displayName());
        }
        User user = userRepository.findByUsername(authentication.getName())
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.UNAUTHORIZED, "Unknown user"));
        String token = jwtService.generate(user.getUsername(), user.getRole(), user.getTenantId());
        return new LoginResponse(token, user.getRole(), user.getDisplayName());
    }

    /** Identity of the current bearer. Requires a valid token. */
    @GetMapping("/me")
    public MeResponse me(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Not authenticated");
        }
        String username = authentication.getName();
        if (authentication instanceof RhAuthentication rh && "iam".equals(rh.getPrincipal().source())) {
            return describe(rh.getPrincipal(), rh.getPrincipal().admin() ? "ADMIN" : "USER", List.of());
        }
        User user = userRepository.findByUsername(username).orElse(null);
        if (user != null) {
            RhPrincipal p = CurrentPrincipal.from(authentication);
            return describe(p, user.getRole(), List.of(), user.getDisplayName());
        }
        // EDGE AUTH: a portal user arriving through the edge gateway has a verified
        // Keycloak token but no row in Report Studio's own User table. Answer from the
        // token's granted role instead of 401 — otherwise the SPA route guard bounces a
        // properly signed-in portal user to /login. An app token whose user was deleted
        // still gets the old 401, because only EdgeBearerAuthFilter grants EDGE_AUTH.
        if (isEdgeAuthenticated(authentication)) {
            return describe(CurrentPrincipal.from(authentication), roleOf(authentication),
                    EdgeBearerAuthFilter.portalRolesOf(authentication));
        }
        throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unknown user");
    }

    private MeResponse describe(RhPrincipal p, String role, List<String> portalRoles) {
        return describe(p, role, portalRoles, p.displayName());
    }

    private MeResponse describe(RhPrincipal p, String role, List<String> portalRoles, String displayName) {
        return new MeResponse(p.username(), role, displayName, portalRoles, p.source(), p.tenantId(), p.admin(),
                List.copyOf(p.roles()), List.copyOf(p.responsibilities()), p.attributes(),
                PermissionService.matrix(p), authMode.value());
    }

    private static boolean isEdgeAuthenticated(Authentication authentication) {
        return authentication.getAuthorities().stream()
                .anyMatch(a -> EdgeBearerAuthFilter.EDGE_AUTHORITY.equals(a.getAuthority()));
    }

    /** {@code ROLE_X} granted by the edge filter → {@code X}; nothing granted → {@code USER}. */
    private static String roleOf(Authentication authentication) {
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(a -> a.startsWith("ROLE_"))
                .map(a -> a.substring("ROLE_".length()))
                .findFirst()
                .orElse("USER");
    }
}
