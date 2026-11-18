package io.reporthub.reportstudio.security;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** User management for the Settings screen. ADMIN-only (enforced in SecurityConfig). */
@RestController
@RequestMapping("/users")
public class UserController {

    public record UserDto(Long id, String username, String role, String displayName) {}
    public record CreateUserRequest(
            @NotBlank(message = "Username is required") @Pattern(regexp = "[a-z0-9_.-]{3,32}", message = "Use 3-32 lowercase letters, digits, dot, dash or underscore") String username,
            @NotBlank(message = "Password is required") @Size(min = 4, max = 100, message = "Password must be 4 to 100 characters") String password,
            @NotBlank @Pattern(regexp = "ADMIN|USER") String role,
            @NotBlank(message = "Display name is required") String displayName) {}
    public record UpdateUserRequest(
            @NotBlank @Pattern(regexp = "ADMIN|USER") String role,
            @NotBlank(message = "Display name is required") String displayName) {}
    public record PasswordRequest(@NotBlank(message = "Password is required") @Size(min = 4, max = 100, message = "Password must be 4 to 100 characters") String password) {}

    private final UserRepository users;
    private final PasswordEncoder encoder;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private JwtService jwt;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private LoginLockout lockout;

    public UserController(UserRepository users, PasswordEncoder encoder) {
        this.users = users;
        this.encoder = encoder;
    }

    /** Caller of a /users request; admin-only is enforced by EndpointPolicy/SecurityConfig, re-checked here. */
    static io.reporthub.reportstudio.iam.RhPrincipal caller() {
        io.reporthub.reportstudio.iam.RhPrincipal p = io.reporthub.reportstudio.iam.CurrentPrincipal.get().orElse(null);
        if (p == null || !p.admin()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "ReportHub admins only");
        return p;
    }

    /** Only a built-in (local) ADMIN may grant ADMIN or set passwords; IAM admins manage USER accounts. */
    static void requireLocalAdmin(io.reporthub.reportstudio.iam.RhPrincipal p, String what) {
        if (!"local".equals(p.source())) throw new ResponseStatusException(HttpStatus.FORBIDDEN, what + " requires a local ReportHub admin");
    }

    static String tenantOf(io.reporthub.reportstudio.iam.RhPrincipal p) {
        return p.tenantId() == null ? "default" : p.tenantId();
    }

    @GetMapping
    public List<UserDto> list() {
        String tenant = tenantOf(caller());
        return users.findAll().stream()
                .filter(u -> tenant.equals(u.getTenantId()))
                .map(u -> new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName()))
                .toList();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserDto create(@Valid @RequestBody CreateUserRequest req) {
        var p = caller();
        if ("ADMIN".equals(req.role())) requireLocalAdmin(p, "Creating an ADMIN account");
        requireLocalAdmin(p, "Setting a password");
        users.findByUsername(req.username()).ifPresent(u -> {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Username already exists");
        });
        User u = new User();
        u.setUsername(req.username());
        u.setPasswordHash(encoder.encode(req.password()));
        u.setRole(req.role());
        u.setDisplayName(req.displayName());
        u.setTenantId(tenantOf(p));
        users.save(u);
        return new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName());
    }

    @PutMapping("/{username}")
    public UserDto update(@PathVariable String username, @Valid @RequestBody UpdateUserRequest req,
                          Authentication auth) {
        var p = caller();
        User u = find(username);
        if ("ADMIN".equals(req.role()) || "ADMIN".equals(u.getRole())) requireLocalAdmin(p, "Changing an ADMIN account");
        // Don't let an admin demote themselves and lock the door behind them.
        if (auth != null && auth.getName().equals(username) && !"ADMIN".equals(req.role())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot demote your own account");
        }
        u.setRole(req.role());
        u.setDisplayName(req.displayName());
        users.save(u);
        return new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName());
    }

    @PostMapping("/{username}/password")
    public UserDto resetPassword(@PathVariable String username, @Valid @RequestBody PasswordRequest req) {
        requireLocalAdmin(caller(), "Resetting a password");
        User u = find(username);
        u.setPasswordHash(encoder.encode(req.password()));
        users.save(u);
        if (jwt != null) jwt.revokeAllFor(u.getUsername());   // old sessions end with the old password
        if (lockout != null) lockout.clear(u.getUsername()); // an admin reset also lifts a sign-in lockout
        return new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName());
    }

    @DeleteMapping("/{username}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String username, Authentication auth) {
        if (auth != null && auth.getName().equals(username)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot delete your own account");
        }
        var p = caller();
        User u = find(username);
        if ("ADMIN".equals(u.getRole())) requireLocalAdmin(p, "Deleting an ADMIN account");
        users.delete(u);
    }

    private User find(String username) {
        String tenant = tenantOf(caller());
        return users.findByUsername(username).filter(u -> tenant.equals(u.getTenantId()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
    }
}
