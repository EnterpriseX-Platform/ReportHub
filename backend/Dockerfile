# Report Studio API — multi-stage Spring Boot image (Java 17).
#
# Builder primes the Maven cache from pom.xml alone (survives source-only
# changes), then builds the repackaged jar. Runtime is a slim non-root JRE
# with TZ set so log timestamps are local.

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

ENV TZ=Asia/Bangkok \
    LANG=th_TH.UTF-8 \
    JAVA_OPTS="-XX:MaxRAMPercentage=75.0"

# Install Thai fonts (DilleniaUPC) required by uploaded .jrxml templates.
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
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
