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
            @NotBlank @Pattern(regexp = "[a-z0-9_.-]{3,32}") String username,
            @NotBlank @Size(min = 4, max = 100) String password,
            @NotBlank @Pattern(regexp = "ADMIN|USER") String role,
            @NotBlank String displayName) {}
    public record UpdateUserRequest(
            @NotBlank @Pattern(regexp = "ADMIN|USER") String role,
            @NotBlank String displayName) {}
    public record PasswordRequest(@NotBlank @Size(min = 4, max = 100) String password) {}

    private final UserRepository users;
    private final PasswordEncoder encoder;

    public UserController(UserRepository users, PasswordEncoder encoder) {
        this.users = users;
        this.encoder = encoder;
    }

    @GetMapping
    public List<UserDto> list() {
        return users.findAll().stream()
                .map(u -> new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName()))
                .toList();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserDto create(@Valid @RequestBody CreateUserRequest req) {
        users.findByUsername(req.username()).ifPresent(u -> {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Username already exists");
        });
        User u = new User();
        u.setUsername(req.username());
        u.setPasswordHash(encoder.encode(req.password()));
        u.setRole(req.role());
        u.setDisplayName(req.displayName());
        users.save(u);
        return new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName());
    }

    @PutMapping("/{username}")
    public UserDto update(@PathVariable String username, @Valid @RequestBody UpdateUserRequest req,
                          Authentication auth) {
        User u = find(username);
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
        User u = find(username);
        u.setPasswordHash(encoder.encode(req.password()));
        users.save(u);
        return new UserDto(u.getId(), u.getUsername(), u.getRole(), u.getDisplayName());
    }

    @DeleteMapping("/{username}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String username, Authentication auth) {
        if (auth != null && auth.getName().equals(username)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot delete your own account");
        }
        users.delete(find(username));
    }

    private User find(String username) {
        return users.findByUsername(username)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
    }
}
