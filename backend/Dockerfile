# Report Studio API — multi-stage Spring Boot image (Java 17).
#
# Builder primes the Maven cache from pom.xml alone (survives source-only
# changes), then builds the repackaged jar. Runtime is a slim non-root JRE
# with TZ configurable (build arg) so log timestamps are local.

# === Build stage ===
FROM maven:3.9.9-eclipse-temurin-17 AS builder

WORKDIR /usr/src/app

# Prime the dependency cache from the POM only.
COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 \
    mvn -q clean package -Dmaven.test.skip -Dmaven.main.skip -Dspring-boot.repackage.skip \
    && rm -rf target/

# Build the real artifact (tests run in CI, not in the image build).
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.m2 mvn -q clean package -DskipTests

# === Runtime stage ===
FROM eclipse-temurin:17-jre AS runtime

# user.language=th makes the JVM default locale Thai so JasperReports wraps Thai text at word
# boundaries (its AWT LineBreakMeasurer uses the default-locale BreakIterator; without a Thai
# default it treats space-less Thai as one unbreakable run and force-breaks mid-word). This must
# be a JVM system property, NOT LANG: the slim base image has no th_TH.UTF-8 locale generated, so
# LANG=th_TH.UTF-8 silently falls back to en_US. The Thai line dictionary lives in jdk.localedata,
# which this JRE includes. Override JVM_LANGUAGE (and app.report.thai-locale) for other deployments.
ARG TZ=UTC
ARG JVM_LANGUAGE=th
ENV TZ=${TZ} \
    JAVA_OPTS="-XX:MaxRAMPercentage=75.0 -Duser.language=${JVM_LANGUAGE}"

# Install the bundled Thai/Latin fonts used by uploaded .jrxml templates.
COPY fonts/ /usr/share/fonts/truetype/thai/
RUN apt-get update -qq && apt-get install -y --no-install-recommends fontconfig \
    && fc-cache -fv \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 1001 -m appuser
USER appuser
WORKDIR /home/appuser/app

COPY --from=builder /usr/src/app/target/report-studio-*.jar ./app.jar

EXPOSE 8080
# Actuator health is exposed at /api/actuator/health (context-path /api).
# Must be `exec` — otherwise PID 1 is sh and Java is its child.
#     sh -c does not forward SIGTERM to the child, so the app never learns it is being stopped;
#     Kubernetes waits out terminationGracePeriodSeconds and then SIGKILLs it,
#     so in-flight renders always die ("Worker restarted while this job was rendering")
#     no matter how server.shutdown=graceful or the grace period are set.
#     `exec` makes java PID 1, receiving signals directly and shutting down gracefully.
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
