package io.reporthub.reportstudio.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables Spring scheduling in one central place.
 *
 * <p>{@code @EnableScheduling} used to sit on {@code SchedulerDispatcher}, one of several timers;
 * disabling that one bean would silently disable every other timer too. Keeping it on a config
 * class makes each timer's switch truly independent.
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
